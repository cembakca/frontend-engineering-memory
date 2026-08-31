import path from "node:path";
import ts from "typescript";
import { readTextIfSmall } from "../utils/fs.js";
import { LocalModuleGraph } from "./module-graph.js";

export type GraphNodeKind="module"|"symbol"|"component"|"server-function"|"cache-key"|"route"|"config"|"backend-endpoint"|"package"|"test"|"verification-command";
export type GraphEdgeType=
  |"imports"|"exports"|"calls"|"renders"|"reads"|"fetches"|"submits-to"|"references"
  |"inherits"|"delegates-to"|"validated-by"|"declares"|"tags"|"invalidates";

export interface GraphEdge {
  type:GraphEdgeType;
  from:string;
  fromKind:GraphNodeKind;
  to:string;
  toKind:GraphNodeKind;
  filePath:string;
  symbol:string|null;
  startLine:number;
  confidence:"observed"|"derived";
  derivationRule?:string;
}

interface ImportBinding {
  /** Repo-relative file, or null when the specifier leaves the repository. */
  file:string|null;
  /** Exported name in the target module; "*" for namespace imports, "default" for default imports. */
  imported:string;
  packageName:string|null;
}

interface ModuleFacts {
  file:string;
  source:ts.SourceFile;
  imports:Map<string,ImportBinding>;
  /** Module-level string constants, already folded where every part is static. */
  constants:Map<string,string>;
  exported:Set<string>;
  components:Set<string>;
  /** Exported names that can actually be invoked, directly or through a member. */
  callables:Set<string>;
  /** Every module-level declared name, exported or not. */
  moduleSymbols:Set<string>;
  serverFunctions:Set<string>;
  /** `export { name } from "./x"` re-exports, keyed by the exported name. */
  reExports:Map<string,{specifier:string;imported:string}>;
}

const MAX_REEXPORT_HOPS=6;

function symbolKey(file:string,name:string):string { return `${file}#${name}`; }

function lineOf(source:ts.SourceFile,node:ts.Node):number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;
}

function declaredName(node:ts.Node):string|null {
  if ((ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node))&&node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)) return node.name.getText();
  return null;
}

/** True for declarations that can hold behaviour, so an inner `const x = ...` never becomes the edge source. */
function isBehaviourHolder(node:ts.Node):boolean {
  if (ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node)||ts.isMethodDeclaration(node)) return true;
  if (!ts.isVariableDeclaration(node)) return false;
  const initializer=node.initializer;
  if (initializer&&(ts.isArrowFunction(initializer)||ts.isFunctionExpression(initializer))) return true;
  // A module-level binding is a named entity of its own (`const adapters = { hcaptcha: ... }`);
  // a binding nested in a function body is not.
  return node.parent?.parent?.parent?.kind===ts.SyntaxKind.SourceFile;
}

/**
 * The nearest enclosing function/class, not the nearest variable. `const response = await fetch(...)`
 * must be attributed to the component that runs it, not to the local binding.
 */
function enclosingSymbol(node:ts.Node):string|null {
  let current:ts.Node|undefined=node;
  while (current) {
    if (isBehaviourHolder(current)) {
      const name=declaredName(current);
      if (name) return name;
    }
    current=current.parent;
  }
  return null;
}

/** Only these can sit on the receiving end of a `calls` edge; an array or string constant cannot. */
function isCallableInitializer(initializer:ts.Expression|undefined):boolean {
  if (!initializer) return false;
  return ts.isArrowFunction(initializer)||ts.isFunctionExpression(initializer)||ts.isObjectLiteralExpression(initializer)
    ||(ts.isAsExpression(initializer)&&isCallableInitializer(initializer.expression))
    ||(ts.isSatisfiesExpression(initializer)&&isCallableInitializer(initializer.expression));
}

function hasExportModifier(node:ts.Node):boolean {
  const modifiers=(node as any).modifiers as ts.NodeArray<ts.ModifierLike>|undefined;
  return Boolean(modifiers?.some((item)=>item.kind===ts.SyntaxKind.ExportKeyword));
}

/** A declaration that returns JSX is treated as a component, not a plain symbol. */
function returnsJsx(node:ts.Node):boolean {
  let found=false;
  const visit=(child:ts.Node):void=>{
    if (found) return;
    if (ts.isJsxElement(child)||ts.isJsxSelfClosingElement(child)||ts.isJsxFragment(child)) { found=true; return; }
    ts.forEachChild(child,visit);
  };
  visit(node);
  return found;
}

function collectModule(file:string,content:string):ModuleFacts {
  const source=ts.createSourceFile(file,content,ts.ScriptTarget.Latest,true,
    /\.tsx?$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const facts:ModuleFacts={file,source,imports:new Map(),constants:new Map(),exported:new Set(),components:new Set(),callables:new Set(),moduleSymbols:new Set(),serverFunctions:new Set(),reExports:new Map()};
  const moduleUseServer=source.statements.some((statement)=>ts.isExpressionStatement(statement)&&ts.isStringLiteral(statement.expression)&&statement.expression.text==="use server");
  const locallyExported=new Set(source.statements.flatMap((statement)=>
    ts.isExportDeclaration(statement)&&!statement.moduleSpecifier&&statement.exportClause&&ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map((element)=>(element.propertyName ?? element.name).text) : []));

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier=statement.moduleSpecifier.text;
      const clause=statement.importClause;
      if (!clause) continue;
      if (clause.name) facts.imports.set(clause.name.getText(),{file:specifier,imported:"default",packageName:null});
      const named=clause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          facts.imports.set(element.name.getText(),{file:specifier,imported:(element.propertyName ?? element.name).getText(),packageName:null});
        }
      } else if (named && ts.isNamespaceImport(named)) {
        facts.imports.set(named.name.getText(),{file:specifier,imported:"*",packageName:null});
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)&&statement.moduleSpecifier&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.exportClause&&ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        facts.reExports.set(element.name.getText(),{specifier:statement.moduleSpecifier.text,imported:(element.propertyName ?? element.name).getText()});
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement)||ts.isClassDeclaration(statement)) {
      const name=statement.name?.getText();
      if (!name) continue;
      if (hasExportModifier(statement)||locallyExported.has(name)) facts.exported.add(name);
      if (returnsJsx(statement)) facts.components.add(name);
      facts.callables.add(name);
      facts.moduleSymbols.add(name);
      const first=ts.isFunctionDeclaration(statement) ? statement.body?.statements[0] : undefined;
      if ((moduleUseServer&&(hasExportModifier(statement)||locallyExported.has(name)))||(first&&ts.isExpressionStatement(first)&&ts.isStringLiteral(first.expression)&&first.expression.text==="use server")) facts.serverFunctions.add(name);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const exported=hasExportModifier(statement);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name=declaration.name.getText();
        facts.moduleSymbols.add(name);
        if (exported||locallyExported.has(name)) facts.exported.add(name);
        if (declaration.initializer&&returnsJsx(declaration.initializer)) facts.components.add(name);
        if (isCallableInitializer(declaration.initializer)) facts.callables.add(name);
        if (declaration.initializer&&(ts.isArrowFunction(declaration.initializer)||ts.isFunctionExpression(declaration.initializer))) {
          const body=declaration.initializer.body;
          const first=ts.isBlock(body) ? body.statements[0] : undefined;
          if ((moduleUseServer&&(exported||locallyExported.has(name)))||(first&&ts.isExpressionStatement(first)&&ts.isStringLiteral(first.expression)&&first.expression.text==="use server")) facts.serverFunctions.add(name);
        }
        const literal=staticStringOf(declaration.initializer);
        if (literal!=null) facts.constants.set(name,literal);
      }
    }
  }
  return facts;
}

/** Fold an expression to a string when every part is a static literal. Returns null otherwise. */
function staticStringOf(expression:ts.Expression|undefined):string|null {
  if (!expression) return null;
  if (ts.isStringLiteralLike(expression)&&!ts.isTemplateExpression(expression)) return expression.text;
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return null;
}

export class SymbolGraph {
  private constructor(
    private readonly repoPath:string,
    private readonly graph:LocalModuleGraph,
    private readonly modules:Map<string,ModuleFacts>,
  ) {}

  static async create(repoPath:string,files:string[]):Promise<SymbolGraph> {
    const graph=await LocalModuleGraph.create(repoPath);
    const modules=new Map<string,ModuleFacts>();
    for (const file of files) {
      const content=await readTextIfSmall(path.join(repoPath,file));
      if (content==null) continue;
      modules.set(file,collectModule(file,content));
    }
    return new SymbolGraph(path.resolve(repoPath),graph,modules);
  }

  /**
   * Resolve an imported local name to the module that actually declares it,
   * following `export { x } from "./y"` barrels. Without this a call through
   * `@/lib/captcha` would be attributed to the barrel instead of the adapter.
   */
  private resolveBinding(file:string,localName:string):{file:string;name:string}|null {
    const binding=this.modules.get(file)?.imports.get(localName);
    if (!binding) return null;
    let target=this.graph.resolve(file,binding.file!);
    let name=binding.imported;
    for (let hop=0;target&&hop<MAX_REEXPORT_HOPS;hop+=1) {
      const facts=this.modules.get(target);
      const forwarded=facts?.reExports.get(name);
      if (!forwarded) break;
      const next=this.graph.resolve(target,forwarded.specifier);
      if (!next) break;
      target=next;
      name=forwarded.imported;
    }
    return target ? {file:target,name} : null;
  }

  /** Fold a fetch/request target to text, resolving local and imported string constants. */
  private resolveTarget(file:string,expression:ts.Expression,depth=0):string|null {
    if (depth>MAX_REEXPORT_HOPS) return null;
    const literal=staticStringOf(expression);
    if (literal!=null) return literal;
    if (ts.isIdentifier(expression)) {
      const name=expression.getText();
      const own=this.modules.get(file)?.constants.get(name);
      if (own!=null) return own;
      const imported=this.resolveBinding(file,name);
      if (!imported) return `\${${name}}`;
      const value=this.modules.get(imported.file)?.constants.get(imported.name);
      return value ?? `\${${imported.name}}`;
    }
    if (ts.isTemplateExpression(expression)) {
      let out=expression.head.text;
      for (const span of expression.templateSpans) {
        const part=this.resolveTarget(file,span.expression,depth+1);
        out+=part ?? "${?}";
        out+=span.literal.text;
      }
      return out;
    }
    if (ts.isPropertyAccessExpression(expression)&&expression.getText().startsWith("process.env.")) {
      return `\${${expression.name.getText()}}`;
    }
    return null;
  }

  private methodOf(call:ts.CallExpression,file:string):string {
    const init=call.arguments[1];
    if (!init||!ts.isObjectLiteralExpression(init)) return "GET";
    for (const property of init.properties) {
      if (!ts.isPropertyAssignment(property)||property.name.getText()!=="method") continue;
      const value=this.resolveTarget(file,property.initializer);
      if (value) return value.toUpperCase();
    }
    return "GET";
  }

  /** Every edge the ontology calls "stored", except `imports`, `inherits` and `delegates-to`. */
  edges(knownRoutes:string[]=[]):GraphEdge[] {
    const routes=new Set(knownRoutes);
    const out:GraphEdge[]=[];
    const push=(edge:GraphEdge):void=>{ out.push(edge); };

    for (const [file,facts] of this.modules) {
      for (const name of facts.exported) {
        push({type:"exports",from:file,fromKind:"module",to:symbolKey(file,name),
          toKind:facts.serverFunctions.has(name) ? "server-function" : facts.components.has(name) ? "component" : "symbol",
          filePath:file,symbol:name,startLine:1,confidence:"observed"});
      }

      const visit=(node:ts.Node):void=>{
        const holder=enclosingSymbol(node);
        const fromKey=holder ? symbolKey(file,holder) : file;
        const fromKind:GraphNodeKind=holder ? (facts.serverFunctions.has(holder) ? "server-function" : facts.components.has(holder) ? "component" : "symbol") : "module";
        const line=lineOf(facts.source,node);

        if (ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)) {
          const tag=node.tagName.getText();
          if (/^[A-Z]/.test(tag)) {
            const target=this.resolveBinding(file,tag);
            if (target) {
              push({type:"renders",from:fromKey,fromKind,to:symbolKey(target.file,target.name),toKind:"component",
                filePath:file,symbol:holder,startLine:line,confidence:"observed"});
            }
          }
        }

        if (ts.isPropertyAccessExpression(node)&&node.getText().startsWith("process.env.")) {
          push({type:"reads",from:fromKey,fromKind,to:node.name.getText(),toKind:"config",
            filePath:file,symbol:holder,startLine:line,confidence:"observed"});
        }

        // An imported symbol used as a value is a real dependency even when it is
        // never called here. `const adapters = { hcaptcha: hcaptchaAdapter }` is the
        // only link into the adapter, because the registry dispatches with adapters[id].
        if (ts.isIdentifier(node)&&!ts.isTypeReferenceNode(node.parent)&&!ts.isImportSpecifier(node.parent)
            &&!ts.isImportClause(node.parent)&&!ts.isNamespaceImport(node.parent)&&!ts.isExportSpecifier(node.parent)
            &&!(ts.isPropertyAccessExpression(node.parent)&&node.parent.name===node)
            &&!(ts.isPropertyAssignment(node.parent)&&node.parent.name===node)
            &&!(ts.isCallExpression(node.parent)&&node.parent.expression===node)
            &&!(ts.isJsxOpeningElement(node.parent)||ts.isJsxSelfClosingElement(node.parent)||ts.isJsxClosingElement(node.parent))) {
          const name=node.getText();
          const target=this.resolveBinding(file,name);
          if (target) {
            push({type:"references",from:fromKey,fromKind,to:symbolKey(target.file,target.name),toKind:"symbol",
              filePath:file,symbol:holder,startLine:line,confidence:"observed"});
          } else if (holder&&holder!==name&&(facts.moduleSymbols.has(name))) {
            // Same-module reference. Without it a dispatch table breaks the chain:
            // resolveCaptchaAdapter -> adapters -> hcaptchaAdapter.
            push({type:"references",from:fromKey,fromKind,to:symbolKey(file,name),toKind:"symbol",
              filePath:file,symbol:holder,startLine:line,confidence:"observed"});
          }
        }

        if (ts.isCallExpression(node)) {
          const callee=node.expression;
          if (ts.isIdentifier(callee)&&callee.getText()==="fetch"&&node.arguments.length) {
            const raw=node.arguments[0]!;
            const target=this.resolveTarget(file,raw);
            if (target) {
              const resolvedFromConstant=!ts.isStringLiteralLike(raw);
              if (target.startsWith("/")&&(!routes.size||routes.has(target))) {
                push({type:"submits-to",from:fromKey,fromKind,to:target,toKind:"route",
                  filePath:file,symbol:holder,startLine:line,
                  confidence:resolvedFromConstant ? "derived" : "observed",
                  ...(resolvedFromConstant ? {derivationRule:"constant-resolution"} : {})});
              } else {
                push({type:"fetches",from:fromKey,fromKind,to:`${this.methodOf(node,file)} ${target}`,toKind:"backend-endpoint",
                  filePath:file,symbol:holder,startLine:line,
                  confidence:resolvedFromConstant ? "derived" : "observed",
                  ...(resolvedFromConstant ? {derivationRule:"constant-resolution"} : {})});
              }
            }
          } else if (ts.isIdentifier(callee)) {
            const name=callee.getText();
            const target=this.resolveBinding(file,name);
            if (target) {
              push({type:"calls",from:fromKey,fromKind,to:symbolKey(target.file,target.name),toKind:this.modules.get(target.file)?.serverFunctions.has(target.name) ? "server-function" : "symbol",
                filePath:file,symbol:holder,startLine:line,confidence:"observed"});
            } else if (facts.callables.has(name)) {
              push({type:"calls",from:fromKey,fromKind,to:symbolKey(file,name),toKind:facts.serverFunctions.has(name) ? "server-function" : "symbol",
                filePath:file,symbol:holder,startLine:line,confidence:"observed"});
            }
          } else if (ts.isPropertyAccessExpression(callee)&&ts.isIdentifier(callee.expression)) {
            const target=this.resolveBinding(file,callee.expression.getText());
            // `CONTACT_SUBJECTS.map(...)` reads a data constant; only a callable receiver is a call.
            if (target&&this.modules.get(target.file)?.callables.has(target.name)) {
              push({type:"calls",from:fromKey,fromKind,to:symbolKey(target.file,target.name),toKind:"symbol",
                filePath:file,symbol:holder,startLine:line,confidence:"observed"});
            }
          }
          const cacheBinding=ts.isIdentifier(callee) ? facts.imports.get(callee.text) : undefined;
          const namespaceBinding=ts.isPropertyAccessExpression(callee)&&ts.isIdentifier(callee.expression) ? facts.imports.get(callee.expression.text) : undefined;
          const cacheCallee=cacheBinding?.file==="next/cache" ? cacheBinding.imported
            : namespaceBinding?.file==="next/cache"&&namespaceBinding.imported==="*"&&ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
          if (cacheCallee&&["cacheTag","revalidateTag","updateTag","revalidatePath","refresh"].includes(cacheCallee)) {
            const target=node.arguments[0] ? this.resolveTarget(file,node.arguments[0]!) : "current-route";
            if (target) push({
              type:["revalidateTag","updateTag","revalidatePath","refresh"].includes(cacheCallee) ? "invalidates" : "tags",
              from:fromKey,fromKind,to:`${cacheCallee.includes("Path")||cacheCallee==="refresh" ? "path" : "tag"}:${target}`,toKind:"cache-key",
              filePath:file,symbol:holder,startLine:line,confidence:"observed",
            });
          }
        }
        ts.forEachChild(node,visit);
      };
      ts.forEachChild(facts.source,visit);
    }

    const seen=new Set<string>();
    return out.filter((edge)=>{
      const key=`${edge.type}|${edge.from}|${edge.to}|${edge.filePath}|${edge.startLine}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

export async function extractSymbolGraph(repoPath:string,files:string[],knownRoutes:string[]=[]):Promise<GraphEdge[]> {
  return (await SymbolGraph.create(repoPath,files)).edges(knownRoutes);
}
