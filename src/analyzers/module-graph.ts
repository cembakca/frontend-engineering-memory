import path from "node:path";
import ts from "typescript";
import { readTextIfSmall } from "../utils/fs.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root,candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function toRelative(root: string, absolute: string): string {
  return path.relative(root,absolute).split(path.sep).join("/");
}

async function compilerOptions(repoPath: string): Promise<ts.CompilerOptions> {
  const configPath = ts.findConfigFile(repoPath,ts.sys.fileExists,"tsconfig.json");
  if (!configPath) {
    return { allowJs:true, jsx:ts.JsxEmit.Preserve, moduleResolution:ts.ModuleResolutionKind.Bundler };
  }
  const loaded = ts.readConfigFile(configPath,ts.sys.readFile);
  if (loaded.error) return { allowJs:true, jsx:ts.JsxEmit.Preserve, moduleResolution:ts.ModuleResolutionKind.Bundler };
  return ts.parseJsonConfigFileContent(loaded.config,ts.sys,path.dirname(configPath)).options;
}

function moduleSpecifiers(source: ts.SourceFile): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length) {
      const first = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport || isRequire) && first && ts.isStringLiteral(first)) found.add(first.text);
    }
    ts.forEachChild(node,visit);
  };
  visit(source);
  return [...found];
}

export class LocalModuleGraph {
  private readonly imports = new Map<string,Promise<string[]>>();

  private constructor(
    private readonly repoPath: string,
    private readonly options: ts.CompilerOptions,
  ) {}

  static async create(repoPath: string): Promise<LocalModuleGraph> {
    return new LocalModuleGraph(path.resolve(repoPath),await compilerOptions(repoPath));
  }

  private importsFor(relativeFile: string): Promise<string[]> {
    const cached = this.imports.get(relativeFile);
    if (cached) return cached;
    const pending = this.resolveImports(relativeFile);
    this.imports.set(relativeFile,pending);
    return pending;
  }

  private async resolveImports(relativeFile: string): Promise<string[]> {
    const absolute = path.join(this.repoPath,relativeFile);
    const content = await readTextIfSmall(absolute);
    if (content == null) return [];
    const source = ts.createSourceFile(absolute,content,ts.ScriptTarget.Latest,true);
    const resolved = new Set<string>();
    for (const specifier of moduleSpecifiers(source)) {
      const match = ts.resolveModuleName(specifier,absolute,this.options,ts.sys).resolvedModule;
      if (!match) continue;
      const target = path.resolve(match.resolvedFileName);
      if (!isInside(this.repoPath,target) || target.endsWith(".d.ts") || !SOURCE_EXTENSIONS.has(path.extname(target))) continue;
      resolved.add(toRelative(this.repoPath,target));
    }
    return [...resolved].sort();
  }

  /** Resolve one module specifier to a repo-relative source file, or null when it leaves the repository. */
  resolve(fromRelativeFile: string, specifier: string): string | null {
    const absolute = path.join(this.repoPath,fromRelativeFile);
    const match = ts.resolveModuleName(specifier,absolute,this.options,ts.sys).resolvedModule;
    if (!match) return null;
    const target = path.resolve(match.resolvedFileName);
    if (!isInside(this.repoPath,target) || target.endsWith(".d.ts") || !SOURCE_EXTENSIONS.has(path.extname(target))) return null;
    return toRelative(this.repoPath,target);
  }

  async reachableFrom(entryFiles: string[]): Promise<string[]> {
    const visited = new Set<string>();
    const queue = [...entryFiles];
    while (queue.length) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      for (const imported of await this.importsFor(current)) {
        if (!visited.has(imported)) queue.push(imported);
      }
    }
    return [...visited];
  }
}
