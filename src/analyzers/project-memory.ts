import { readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { readTextIfSmall } from "../utils/fs.js";
import { walkFiles } from "../utils/walk.js";
import type { DependencyCandidate, MemoryCandidate } from "../types.js";

const NEXT_CONFIG_KEYS=new Set([
  "basePath","assetPrefix","trailingSlash","output","distDir","pageExtensions","transpilePackages",
  "cacheComponents","typedRoutes","images","serverActions","experimental","i18n",
]);

function unwrap(expression:ts.Expression):ts.Expression {
  if (ts.isAsExpression(expression)||ts.isSatisfiesExpression(expression)||ts.isParenthesizedExpression(expression)) return unwrap(expression.expression);
  return expression;
}

function staticSummary(expression:ts.Expression):string|null {
  const value=unwrap(expression);
  if (ts.isStringLiteralLike(value)||ts.isNumericLiteral(value)) return JSON.stringify(value.text);
  if (value.kind===ts.SyntaxKind.TrueKeyword) return "true";
  if (value.kind===ts.SyntaxKind.FalseKeyword) return "false";
  if (value.kind===ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isArrayLiteralExpression(value)) {
    const items=value.elements.map((item)=>staticSummary(item as ts.Expression));
    return items.every((item)=>item!=null) ? `[${items.join(", ")}]` : `[${value.elements.length} entries]`;
  }
  if (ts.isObjectLiteralExpression(value)) {
    const keys=value.properties.flatMap((property)=>"name" in property ? [property.name?.getText().replace(/^['"]|['"]$/g,"")].filter(Boolean) : []);
    return `{ keys: ${keys.slice(0,30).join(", ")} }`;
  }
  return null;
}

function configObject(source:ts.SourceFile):ts.ObjectLiteralExpression|null {
  const objects=new Map<string,ts.ObjectLiteralExpression>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)&&declaration.initializer) {
          const value=unwrap(declaration.initializer);
          if (ts.isObjectLiteralExpression(value)) objects.set(declaration.name.text,value);
        }
      }
    }
  }
  const resolve=(expression:ts.Expression):ts.ObjectLiteralExpression|null=>{
    const value=unwrap(expression);
    if (ts.isObjectLiteralExpression(value)) return value;
    if (ts.isIdentifier(value)) return objects.get(value.text) ?? null;
    if (ts.isCallExpression(value)) {
      for (const argument of value.arguments) {
        const candidate=resolve(argument);
        if (candidate) return candidate;
      }
    }
    return null;
  };
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      const value=resolve(statement.expression);
      if (value) return value;
    }
    if (ts.isExpressionStatement(statement)&&ts.isBinaryExpression(statement.expression)) {
      const assignment=statement.expression;
      if (assignment.left.getText()==="module.exports") {
        const value=resolve(assignment.right);
        if (value) return value;
      }
    }
  }
  return objects.get("nextConfig") ?? objects.get("config") ?? null;
}

function propertyKey(property:ts.ObjectLiteralElementLike):string|null {
  if (!("name" in property)||!property.name) return null;
  return property.name.getText().replace(/^['"]|['"]$/g,"");
}

function lineOf(source:ts.SourceFile,node:ts.Node):number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;
}

export interface RouteRewriteRule {
  kind:"rewrites"|"redirects"|"headers";
  source:string;
  destination:string|null;
  file:string;
  line:number;
}

const RULE_KEYS=new Set(["rewrites","redirects","headers"]);

/**
 * Routing rules are recognised by their shape (`{source, destination}`), not by
 * the file that happens to hold them: a project may declare them inline in
 * `next.config.*` or in a separate `rewrites.config.ts` that the config imports.
 * Only the first form used to be indexed, which hid every localized public URL
 * of the projects that split the file out.
 */
export function extractRouteRewrites(sourceFile:string,content:string):RouteRewriteRule[] {
  const source=ts.createSourceFile(sourceFile,content,ts.ScriptTarget.Latest,true,
    sourceFile.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const out:RouteRewriteRule[]=[];
  const visit=(node:ts.Node,kind:RouteRewriteRule["kind"]|null):void=>{
    let scope=kind;
    const named=ts.isPropertyAssignment(node)||ts.isMethodDeclaration(node)||ts.isFunctionDeclaration(node)
      ||ts.isVariableDeclaration(node)||ts.isShorthandPropertyAssignment(node);
    if (named&&"name" in node&&node.name) {
      const key=node.name.getText().replace(/^['"]|['"]$/g,"");
      if (RULE_KEYS.has(key)) scope=key as RouteRewriteRule["kind"];
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties=new Map(node.properties.map((item)=>[propertyKey(item),item]));
      const sourceProperty=properties.get("source");
      if (sourceProperty&&ts.isPropertyAssignment(sourceProperty)) {
        const from=staticSummary(sourceProperty.initializer) ?? sourceProperty.initializer.getText();
        const destinationProperty=properties.get("destination");
        const destination=destinationProperty&&ts.isPropertyAssignment(destinationProperty)
          ? staticSummary(destinationProperty.initializer) ?? destinationProperty.initializer.getText() : null;
        // A file that only declares rules carries no enclosing key to read the
        // kind from, so it is inferred from the rule's own shape.
        const inferred:RouteRewriteRule["kind"]=scope ?? (properties.has("permanent") ? "redirects"
          : destination ? "rewrites" : "headers");
        out.push({kind:inferred,source:from,destination,file:sourceFile,line:lineOf(source,node)});
        return;
      }
    }
    ts.forEachChild(node,(child)=>visit(child,scope));
  };
  visit(source,null);
  return out;
}

function rewriteMemory(rule:RouteRewriteRule):MemoryCandidate {
  const behavior=rule.destination ? `${rule.source} -> ${rule.destination}`
    : rule.kind==="headers" ? `${rule.source} with response headers` : rule.source;
  return {type:"next_config",subject:`${rule.file}:${rule.kind}:${rule.source}`,
    content:`Next.js ${rule.kind} rule ${behavior}.`,confidence:"verified",sourceFile:rule.file,
    startLine:rule.line,endLine:rule.line};
}

function analyzeNextConfig(sourceFile:string,content:string):MemoryCandidate[] {
  const source=ts.createSourceFile(sourceFile,content,ts.ScriptTarget.Latest,true,sourceFile.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const root=configObject(source);
  if (!root) return [];
  const out:MemoryCandidate[]=[];
  for (const property of root.properties) {
    const key=propertyKey(property);
    if (!key) continue;
    if (NEXT_CONFIG_KEYS.has(key)&&ts.isPropertyAssignment(property)) {
      const summary=staticSummary(property.initializer) ?? property.initializer.getText().replace(/\s+/g," ").slice(0,300);
      out.push({type:"next_config",subject:`${sourceFile}:${key}`,content:`Next.js configuration ${key} is set to ${summary}.`,confidence:"verified",sourceFile,startLine:lineOf(source,property),endLine:source.getLineAndCharacterOfPosition(property.getEnd()).line+1});
    }
  }
  return out;
}

export async function listProjectAnalysisFiles(repoPath:string):Promise<string[]> {
  let names:string[]=[];
  try { names=await readdir(repoPath); } catch { return []; }
  const rootFiles=names.filter((name)=>
    /^Dockerfile(?:\..+)?$/.test(name) ||
    /^docker-compose.*\.ya?ml$/.test(name) ||
    // Any root config module, not just next.config.*: routing rules are often
    // split into rewrites.config.ts / redirects.config.ts.
    /^[\w.-]*config\.(?:ts|js|mjs|cjs)$/.test(name) ||
    /^tsconfig\.json$/.test(name) ||
    /^\.env(?:\..+)?$/.test(name),
  );
  const staticMetadata=await walkFiles(repoPath,{extensions:new Set([".txt",".xml",".webmanifest"]),include:(file)=>
    /^(?:src\/)?app\/(?:.*\/)?(?:robots\.txt|sitemap\.xml|manifest\.webmanifest)$/.test(file)});
  return [...new Set([...rootFiles,...staticMetadata])].sort();
}

/** Every routing rule the repository declares, wherever it declares them. */
export async function analyzeRouteRewrites(repoPath:string):Promise<RouteRewriteRule[]> {
  const files=(await listProjectAnalysisFiles(repoPath)).filter((file)=>/config\.(?:ts|js|mjs|cjs)$/.test(file));
  const rules:RouteRewriteRule[]=[];
  for (const file of files) {
    const content=await readTextIfSmall(path.join(repoPath,file),1_000_000);
    if (content==null) continue;
    rules.push(...extractRouteRewrites(file,content));
  }
  return rules;
}

export async function analyzeProjectFile(repoPath:string,sourceFile:string):Promise<MemoryCandidate[]> {
  const content=await readTextIfSmall(path.join(repoPath,sourceFile),1_000_000);
  if (content==null) return [];
  const out:MemoryCandidate[]=[];
  const staticSpecial=sourceFile.match(/(?:^|\/)(robots\.txt|sitemap\.xml|manifest\.webmanifest)$/);
  if (staticSpecial) out.push({type:"special_file",subject:sourceFile,content:`${sourceFile} implements the static Next.js ${staticSpecial[1]} metadata file convention.`,confidence:"verified",sourceFile,startLine:1,endLine:content.split("\n").length});
  if (/^next\.config\.(?:ts|js|mjs|cjs)$/.test(sourceFile)) out.push(...analyzeNextConfig(sourceFile,content));
  if (/^[\w.-]*config\.(?:ts|js|mjs|cjs)$/.test(sourceFile)) {
    for (const rule of extractRouteRewrites(sourceFile,content)) out.push(rewriteMemory(rule));
  }
  if (/^Dockerfile/.test(sourceFile) || /^docker-compose/.test(sourceFile)) {
    const bases=[...content.matchAll(/^FROM\s+([^\s]+)/gm)].map((match)=>match[1]).filter(Boolean);
    out.push({type:"build",subject:sourceFile,content:`${sourceFile} defines container build/runtime${bases.length ? ` with base images ${bases.join(", ")}` : ""}.`,confidence:"verified",sourceFile,startLine:1,endLine:content.split("\n").length});
  }
  if (sourceFile==="tsconfig.json") {
    out.push({type:"build",subject:sourceFile,content:`${sourceFile} defines TypeScript compiler and module-resolution configuration.`,confidence:"verified",sourceFile,startLine:1,endLine:content.split("\n").length});
  }
  if (/^\.env/.test(sourceFile)) {
    for (const match of content.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)) {
      out.push({type:"configuration",subject:match[1]!,content:`${sourceFile} declares configuration key ${match[1]}.`,confidence:"verified",sourceFile,startLine:content.slice(0,match.index ?? 0).split("\n").length});
    }
  }
  return out;
}

export function dependencyMemories(dependencies:DependencyCandidate[]):MemoryCandidate[] {
  return dependencies.map((dependency)=>({
    type:"dependency",
    subject:`${dependency.dependencyType}:${dependency.name}`,
    content:`${dependency.name} is recorded as ${dependency.dependencyType} dependency (${dependency.category})${dependency.purpose ? ` for ${dependency.purpose}` : ""}.`,
    confidence:"verified",
    sourceFile:dependency.sourceFile,
    sourceSymbol:dependency.sourceSymbol,
    startLine:dependency.startLine,
  }));
}
