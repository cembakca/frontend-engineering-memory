import { access } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { readTextIfSmall } from "../utils/fs.js";

export interface MiddlewareAnalysis {
  sourceFile:string;
  matchers:string[];
  authSignal:boolean;
}

async function middlewareFile(repoPath:string):Promise<string|null> {
  for (const base of ["middleware","src/middleware","proxy","src/proxy"]) {
    for (const ext of ["ts","js"]) {
      const relative=`${base}.${ext}`;
      try { await access(path.join(repoPath,relative)); return relative; } catch {}
    }
  }
  return null;
}

function staticStrings(node:ts.Expression):string[] {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((item)=>ts.isExpression(item) ? staticStrings(item) : []);
  if (ts.isObjectLiteralExpression(node)) {
    const source=node.properties.find((property)=>ts.isPropertyAssignment(property) && property.name.getText().replace(/["']/g,"")==="source");
    return source && ts.isPropertyAssignment(source) ? staticStrings(source.initializer) : [];
  }
  return [];
}

export async function analyzeMiddleware(repoPath:string):Promise<MiddlewareAnalysis|null> {
  const sourceFile=await middlewareFile(repoPath);
  if (!sourceFile) return null;
  const content=(await readTextIfSmall(path.join(repoPath,sourceFile))) ?? "";
  const source=ts.createSourceFile(sourceFile,content,ts.ScriptTarget.Latest,true);
  let matchers:string[]=[];
  source.forEachChild((node)=>{
    if (!ts.isVariableStatement(node) || !node.modifiers?.some((modifier)=>modifier.kind===ts.SyntaxKind.ExportKeyword)) return;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text!=="config" || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue;
      const matcher=declaration.initializer.properties.find((property)=>ts.isPropertyAssignment(property) && property.name.getText().replace(/["']/g,"")==="matcher");
      if (matcher && ts.isPropertyAssignment(matcher)) matchers=staticStrings(matcher.initializer);
    }
  });
  return {sourceFile,matchers:[...new Set(matchers)],authSignal:/\b(access_token|refresh_token|session|auth(?:entication|orization)?|isLoggedIn)\b/i.test(content)};
}

function matcherRegex(matcher:string):RegExp|null {
  try {
    let pattern=matcher;
    pattern=pattern.replace(/\/:([A-Za-z0-9_]+)\*/g,"(?:/.*)?");
    pattern=pattern.replace(/\/:([A-Za-z0-9_]+)\+/g,"/.+");
    pattern=pattern.replace(/\/:([A-Za-z0-9_]+)\?/g,"(?:/[^/]+)?");
    pattern=pattern.replace(/\/:([A-Za-z0-9_]+)/g,"/[^/]+");
    return new RegExp(`^${pattern}$`);
  } catch { return null; }
}

export function middlewareMatches(route:string, analysis:MiddlewareAnalysis|null):boolean|null {
  if (!analysis) return null;
  if (!analysis.matchers.length) return true;
  return analysis.matchers.some((matcher)=>matcherRegex(matcher)?.test(route) ?? false);
}
