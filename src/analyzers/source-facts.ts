import ts from "typescript";

export interface LocatedSignal {
  value: string;
  line: number;
  endLine: number;
  symbol: string | null;
}

export interface DataSourceSignal extends LocatedSignal {
  kind: "fetch" | "axios" | "ky" | "graphql" | "api-client";
}

export interface SourceFacts {
  imports: LocatedSignal[];
  internalPackages: LocatedSignal[];
  envKeys: LocatedSignal[];
  dataSources: DataSourceSignal[];
  cacheBehavior: LocatedSignal[];
  clientBoundary: boolean;
  stateLibraries: LocatedSignal[];
  securitySignals: LocatedSignal[];
  performanceSignals: LocatedSignal[];
  businessRules: LocatedSignal[];
}

function nodeName(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) && node.name) {
    return node.name.getText();
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent=node.parent;
    if (ts.isVariableDeclaration(parent) && parent.name) return parent.name.getText();
  }
  return null;
}

function enclosingSymbol(node: ts.Node): string | null {
  let current: ts.Node | undefined=node;
  while (current) {
    const name=nodeName(current);
    if (name) return name;
    current=current.parent;
  }
  return null;
}

function located(source: ts.SourceFile, node: ts.Node, value: string): LocatedSignal {
  return {
    value,
    line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,
    endLine:source.getLineAndCharacterOfPosition(node.getEnd()).line+1,
    symbol:enclosingSymbol(node),
  };
}

function expressionValue(expression: ts.Expression | undefined): string {
  if (!expression) return "unknown";
  if (ts.isStringLiteralLike(expression)) return expression.text;
  return expression.getText().replace(/\s+/g," ").slice(0,240);
}

function callIdentity(expression: ts.LeftHandSideExpression): {root:string;method:string|null} {
  if (ts.isIdentifier(expression)) return {root:expression.text,method:null};
  if (ts.isPropertyAccessExpression(expression)) {
    let root: ts.Expression=expression.expression;
    while (ts.isPropertyAccessExpression(root)) root=root.expression;
    return {root:ts.isIdentifier(root) ? root.text : root.getText(),method:expression.name.text};
  }
  return {root:expression.getText(),method:null};
}

function pushUnique<T extends LocatedSignal>(rows: T[], row: T, key: (item:T)=>string = (item)=>`${item.value}:${item.line}`): void {
  if (!rows.some((item)=>key(item)===key(row))) rows.push(row);
}

function nodeAtPosition(source:ts.SourceFile,position:number):ts.Node {
  let best:ts.Node=source;
  const visit=(node:ts.Node):void=>{
    if (node.getStart(source)<=position && node.getEnd()>=position) {
      best=node;
      ts.forEachChild(node,visit);
    }
  };
  visit(source);
  return best;
}

export function extractSourceFacts(sourceFile: string, content: string): SourceFacts {
  const source=ts.createSourceFile(sourceFile,content,ts.ScriptTarget.Latest,true,sourceFile.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const facts: SourceFacts={
    imports:[],internalPackages:[],envKeys:[],dataSources:[],cacheBehavior:[],clientBoundary:false,
    stateLibraries:[],securitySignals:[],performanceSignals:[],businessRules:[],
  };
  const statePattern=/(^|\/)(redux|zustand|jotai|mobx|recoil)(\/|$)|@reduxjs\/toolkit/;

  const visit=(node:ts.Node):void=>{
    if (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text==="use client") facts.clientBoundary=true;

    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const value=node.moduleSpecifier.text;
      const signal=located(source,node,value);
      pushUnique(facts.imports,signal,(item)=>item.value);
      if (value.startsWith("@hangikredi/")) {
        const packageName=value.split("/").slice(0,2).join("/");
        pushUnique(facts.internalPackages,{...signal,value:packageName},(item)=>item.value);
      }
      if (statePattern.test(value)) pushUnique(facts.stateLibraries,signal,(item)=>item.value);
      if (/^(next\/dynamic|react)$/.test(value)) pushUnique(facts.performanceSignals,located(source,node,`performance import ${value}`));
      if (/(jose|jsonwebtoken|dompurify|sanitize-html)/.test(value)) pushUnique(facts.securitySignals,located(source,node,`security package ${value}`));
    }

    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const left=node.expression;
      if (ts.isIdentifier(left.expression) && left.expression.text==="process" && left.name.text==="env") {
        pushUnique(facts.envKeys,located(source,node,node.name.text),(item)=>item.value);
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const left=node.expression;
      if (ts.isIdentifier(left.expression) && left.expression.text==="process" && left.name.text==="env" && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
        pushUnique(facts.envKeys,located(source,node,node.argumentExpression.text),(item)=>item.value);
      }
    }

    if (ts.isCallExpression(node)) {
      const identity=callIdentity(node.expression);
      let kind: DataSourceSignal["kind"] | null=null;
      if (identity.root==="fetch") kind="fetch";
      else if (identity.root==="axios") kind="axios";
      else if (identity.root==="ky") kind="ky";
      else if (/graphql|apollo/i.test(identity.root)) kind="graphql";
      else if (/(api|http|client)$/i.test(identity.root) && /^(get|post|put|patch|delete|request|query|mutate)$/i.test(identity.method ?? "")) kind="api-client";
      if (kind) {
        const base=located(source,node,expressionValue(node.arguments[0]));
        pushUnique(facts.dataSources,{...base,kind});
      }
      const callName=identity.method ?? identity.root;
      if (["cache","unstable_cache","cacheLife","revalidatePath","revalidateTag"].includes(callName)) {
        pushUnique(facts.cacheBehavior,located(source,node,`${callName}()`));
      }
      if (["memo","useMemo","useCallback","dynamic"].includes(callName)) {
        pushUnique(facts.performanceSignals,located(source,node,`${callName}()`));
      }
    }
    ts.forEachChild(node,visit);
  };
  visit(source);

  for (const match of content.matchAll(/cache\s*:\s*["'](no-store|force-cache)["']/g)) {
    const pos=match.index ?? 0;
    pushUnique(facts.cacheBehavior,located(source,nodeAtPosition(source,pos),`fetch cache=${match[1]}`));
  }
  for (const match of content.matchAll(/\brevalidate\s*[:=]\s*(\d+|false)/g)) {
    const pos=match.index ?? 0;
    pushUnique(facts.cacheBehavior,located(source,nodeAtPosition(source,pos),`revalidate=${match[1]}`));
  }
  for (const match of content.matchAll(/(?:Content-Security-Policy|X-Frame-Options|strict-transport-security|nonce\b|sanitize\w*\s*\()/gi)) {
    pushUnique(facts.securitySignals,located(source,nodeAtPosition(source,match.index ?? 0),match[0]));
  }
  for (const match of content.matchAll(/BUSINESS_RULE\s*:\s*([^\n]+)/g)) {
    pushUnique(facts.businessRules,located(source,nodeAtPosition(source,match.index ?? 0),(match[1] ?? "").trim()));
  }
  return facts;
}

export function enrichEvidence(sourceFile:string, content:string, line:number | null | undefined): {symbol:string|null;endLine:number|null} {
  if (!line) return {symbol:null,endLine:null};
  const source=ts.createSourceFile(sourceFile,content,ts.ScriptTarget.Latest,true,sourceFile.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const offset=source.getPositionOfLineAndCharacter(Math.max(0,line-1),0);
  let best:ts.Node=source;
  const visit=(node:ts.Node):void=>{
    if (node.getStart(source)<=offset && node.getEnd()>=offset) {
      best=node;
      ts.forEachChild(node,visit);
    }
  };
  visit(source);
  return {symbol:enclosingSymbol(best),endLine:source.getLineAndCharacterOfPosition(best.getEnd()).line+1};
}
