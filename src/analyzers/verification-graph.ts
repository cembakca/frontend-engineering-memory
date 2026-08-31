import path from "node:path";
import ts from "typescript";
import type { GraphEdge, GraphNodeKind } from "./symbol-graph.js";
import { LocalModuleGraph } from "./module-graph.js";
import { readTextIfSmall } from "../utils/fs.js";

export type VerificationCommandKind="test"|"typecheck"|"lint"|"build";
export type VerificationGapKind="missing-test-command"|"missing-test-files"|"unvalidated-target";

export interface VerificationCommand {
  key:string;
  name:string;
  kind:VerificationCommandKind;
  command:string;
  file:string;
  line:number;
}

export interface VerificationTest {
  key:string;
  file:string;
  title:string;
  framework:"node-test"|"vitest"|"jest"|"playwright"|"unknown";
  line:number;
  targets:string[];
}

export interface VerificationTarget {
  key:string;
  kind:"route"|"symbol"|"component";
  file:string;
}

export interface VerificationGap {
  kind:VerificationGapKind;
  target?:string;
  targetKind?:VerificationTarget["kind"];
  reason:string;
}

export interface VerificationGraph {
  commands:VerificationCommand[];
  tests:VerificationTest[];
  edges:GraphEdge[];
  gaps:VerificationGap[];
}

export interface VerificationOptions {
  packageFile?:string;
  targets?:VerificationTarget[];
  routes?:Array<{route:string;sourceFile:string}>;
}

const TEST_FILE=/(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec))\.[cm]?[jt]sx?$/;

function commandKind(name:string,command:string):VerificationCommandKind|null {
  const script=name.toLowerCase();
  const value=command.toLowerCase();
  const invokesTestRunner=/(?:^|[\s;&|])(?:jest|vitest|playwright|cypress)(?:\s|$)/.test(value)
    ||/(?:^|[\s;&|])(?:node|tsx)(?:\s+[^;&|]+)*\s+--test(?:\s|$)/.test(value);
  if (/^test(?::|$)/.test(script)||invokesTestRunner) return "test";
  if (/^(?:typecheck|type-check)(?::|$)/.test(script)||/\btsc\b[^\n]*--noemit\b/.test(value)) return "typecheck";
  if (/^lint(?::|$)/.test(script)||/(?:^|[\s;&|])eslint(?:\s|$)/.test(value)) return "lint";
  if (/^build(?::|$)/.test(script)) return "build";
  return null;
}

function lineForScript(raw:string,name:string):number {
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const match=new RegExp(`^[ \\t]*["']${escaped}["'][ \\t]*:`,`m`).exec(raw);
  return match ? raw.slice(0,match.index).split("\n").length : 1;
}

async function commandsFrom(repoPath:string,packageFile:string):Promise<VerificationCommand[]> {
  const raw=await readTextIfSmall(path.join(repoPath,packageFile),2_000_000);
  if (!raw) return [];
  let scripts:Record<string,unknown>={};
  try { scripts=(JSON.parse(raw) as {scripts?:Record<string,unknown>}).scripts ?? {}; } catch { return []; }
  const out:VerificationCommand[]=[];
  for (const [name,value] of Object.entries(scripts)) {
    if (typeof value!=="string") continue;
    const kind=commandKind(name,value);
    if (!kind) continue;
    out.push({key:`script:${name}`,name,kind,command:value,file:packageFile,line:lineForScript(raw,name)});
  }
  return out;
}

function frameworkOf(source:ts.SourceFile):VerificationTest["framework"] {
  const imports=source.statements.filter(ts.isImportDeclaration)
    .map((item)=>ts.isStringLiteral(item.moduleSpecifier) ? item.moduleSpecifier.text : "");
  if (imports.some((item)=>item==="node:test")) return "node-test";
  if (imports.some((item)=>item.startsWith("vitest"))) return "vitest";
  if (imports.some((item)=>item.startsWith("@playwright/test"))) return "playwright";
  if (imports.some((item)=>item.includes("jest"))||/\bjest\./.test(source.text)) return "jest";
  return "unknown";
}

function literalTitle(node:ts.CallExpression):string|null {
  const first=node.arguments[0];
  return first&&ts.isStringLiteralLike(first) ? first.text : null;
}

function callName(node:ts.CallExpression):string|null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function callbackOf(node:ts.CallExpression):ts.FunctionLikeDeclaration|null {
  const candidate=node.arguments[1];
  return candidate&&(ts.isArrowFunction(candidate)||ts.isFunctionExpression(candidate)) ? candidate : null;
}

interface Binding { file:string; imported:string }

async function testsFromFile(
  repoPath:string,file:string,moduleGraph:LocalModuleGraph,knownRoutes:Set<string>,routeFiles:Map<string,string>,
):Promise<{tests:VerificationTest[];edges:GraphEdge[]}> {
  const raw=await readTextIfSmall(path.join(repoPath,file));
  if (raw==null) return {tests:[],edges:[]};
  const source=ts.createSourceFile(file,raw,ts.ScriptTarget.Latest,true,/x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bindings=new Map<string,Binding>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target=moduleGraph.resolve(file,statement.moduleSpecifier.text);
    if (!target||target===file) continue;
    const clause=statement.importClause;
    if (clause?.name) bindings.set(clause.name.text,{file:target,imported:"default"});
    if (clause?.namedBindings&&ts.isNamedImports(clause.namedBindings)) {
      for (const item of clause.namedBindings.elements) {
        bindings.set(item.name.text,{file:target,imported:(item.propertyName ?? item.name).text});
      }
    }
  }

  const tests:VerificationTest[]=[];
  const edges:GraphEdge[]=[];
  const framework=frameworkOf(source);
  const lineOf=(node:ts.Node)=>source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;

  const walk=(node:ts.Node,suites:string[]):void=>{
    if (ts.isCallExpression(node)) {
      const name=callName(node);
      const title=literalTitle(node);
      const callback=callbackOf(node);
      if (name==="describe"&&title&&callback) {
        ts.forEachChild(callback,(child)=>walk(child,[...suites,title]));
        return;
      }
      if ((name==="test"||name==="it")&&title&&callback) {
        const fullTitle=[...suites,title].join(" > ");
        const key=`${file}#${fullTitle}`;
        const targets=new Set<string>();
        const visitBody=(child:ts.Node):void=>{
          if (ts.isIdentifier(child)) {
            const binding=bindings.get(child.text);
            if (binding) targets.add(`${binding.file}#${binding.imported}`);
          }
          if (ts.isStringLiteralLike(child)&&knownRoutes.has(child.text)) targets.add(child.text);
          ts.forEachChild(child,visitBody);
        };
        visitBody(callback);
        const test:VerificationTest={key,file,title:fullTitle,framework,line:lineOf(node),targets:[...targets]};
        tests.push(test);
        for (const target of targets) {
          const isRoute=knownRoutes.has(target);
          const targetFile=isRoute ? routeFiles.get(target) ?? file : target.split("#")[0]!;
          edges.push({type:"validated-by",from:target,fromKind:isRoute ? "route" : "symbol",to:key,toKind:"test",
            filePath:file,symbol:fullTitle,startLine:test.line,confidence:"observed"});
          // Importing a route handler validates its symbol; also expose the route identity.
          if (!isRoute) {
            for (const [route,routeFile] of routeFiles) {
              if (routeFile!==targetFile) continue;
              edges.push({type:"validated-by",from:route,fromKind:"route",to:key,toKind:"test",
                filePath:file,symbol:fullTitle,startLine:test.line,confidence:"observed"});
            }
          }
        }
        return;
      }
    }
    ts.forEachChild(node,(child)=>walk(child,suites));
  };
  walk(source,[]);
  return {tests,edges};
}

export async function extractVerificationGraph(repoPath:string,files:string[],options:VerificationOptions={}):Promise<VerificationGraph> {
  const packageFile=options.packageFile ?? "package.json";
  const commands=await commandsFrom(repoPath,packageFile);
  const testFiles=[...new Set(files.filter((file)=>TEST_FILE.test(file.replaceAll("\\","/"))))].sort();
  const graph=await LocalModuleGraph.create(repoPath);
  const routeFiles=new Map((options.routes ?? []).map((route)=>[route.route,route.sourceFile]));
  const knownRoutes=new Set(routeFiles.keys());
  const tests:VerificationTest[]=[];
  const edges:GraphEdge[]=[];
  for (const file of testFiles) {
    const extracted=await testsFromFile(repoPath,file,graph,knownRoutes,routeFiles);
    tests.push(...extracted.tests);
    edges.push(...extracted.edges);
  }

  const gaps:VerificationGap[]=[];
  if (!commands.some((item)=>item.kind==="test")) {
    gaps.push({kind:"missing-test-command",reason:`${packageFile} has no test runner script`});
  }
  if (!testFiles.length) gaps.push({kind:"missing-test-files",reason:"No repository test/spec files were discovered"});
  const validated=new Set(edges.map((edge)=>edge.from));
  for (const target of options.targets ?? []) {
    if (validated.has(target.key)) continue;
    gaps.push({kind:"unvalidated-target",target:target.key,targetKind:target.kind,
      reason:`No validated-by edge reaches ${target.key}`});
  }
  return {commands,tests,edges,gaps};
}
