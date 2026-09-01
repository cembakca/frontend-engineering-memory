export type RouterType = "app" | "pages" | "hybrid" | "unknown";

export type RenderingMode =
  | "static"
  | "ssg"
  | "isr"
  | "ssr"
  | "dynamic-ssr"
  | "rsc"
  | "csr"
  | "hybrid"
  | "unknown";

export type MemoryType =
  | "repository_profile"
  | "rendering"
  | "api_dependency"
  | "data_fetching"
  | "cache"
  | "cache_invalidation"
  | "server_function"
  | "authentication"
  | "authorization"
  | "middleware"
  | "state_management"
  | "design_system"
  | "shared_package"
  | "seo"
  | "analytics"
  | "analytics_event"
  | "error_handling"
  | "module_contract"
  | "schema_contract"
  | "next_config"
  | "special_file"
  | "configuration"
  | "build"
  | "dependency"
  | "security"
  | "performance_observation"
  | "business_capability"
  | "business_rule"
  | "technical_debt";

export interface RepositoryConfig {
  name: string;
  path: string;
  mainBranch?: string;
  managedCheckout?: boolean;
  remote?: string;
  /** Repository vocabulary groups used to bridge product language and source-code terminology. */
  queryAliases?: Record<string,string[]>;
  /** Explicit package-name prefixes owned by the organization, for example `@company/`. */
  internalPackagePrefixes?: string[];
}

export interface RepositoryRegistry {
  repositories: RepositoryConfig[];
}

export interface RepositoryProfile {
  name: string;
  path: string;
  framework: string;
  nextVersion: string | null;
  reactVersion: string | null;
  nodeVersion: string | null;
  routerType: RouterType;
  packageManager: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  devCommand: string | null;
  outputMode: string | null;
  packageName: string | null;
  packageDependencies: Array<{
    name: string;
    kind: "runtime" | "development" | "optional" | "peer";
  }>;
  evidenceFiles: string[];
}

export interface RouteDependencyCandidate {
  dependencyType: DependencyCandidate["dependencyType"];
  name: string;
  usageType: "api-call" | "configuration" | "internal-package" | "data-fetching" | "shared-module";
  sourceFile: string;
  sourceSymbol?: string | null;
  startLine?: number | null;
}

export interface RouteRecord {
  route: string;
  routeType: "page" | "api" | "route-handler" | "special";
  routerType: "app" | "pages";
  sourceFile: string;
  layoutChain: string[];
  renderingMode: RenderingMode;
  dynamicRoute: boolean;
  routeParams: string[];
  authRequired: boolean | null;
  middlewareMatched: boolean | null;
  metadataMode: "static" | "dynamic" | "none" | "unknown";
  serverComponent: boolean | null;
  clientBoundaries: string[];
  dataSources: string[];
  backendDependencies: string[];
  cacheBehavior: string[];
  seoType: "static" | "dynamic" | "file-based" | "none" | "unknown";
  metadataSource: string | null;
  middlewareMatchers: string[];
  evidence: string[];
  behaviorFiles: string[];
  dependencies: RouteDependencyCandidate[];
  /** Route segment config declared by the page itself; authoritative over helper signals. */
  segmentConfig: Record<string,string>;
  /** `redirect()` / `notFound()` reached on this route. A page that always redirects never renders. */
  controlFlow: Array<{ kind: "redirect" | "permanent-redirect" | "not-found"; target: string | null; conditional: boolean }>;
  /** How renderingMode was reached: read from the file, inherited from a directive, or defaulted because no signal was found. */
  renderingBasis: "observed" | "directive" | "inherited" | "default";
}

export interface MemoryCandidate {
  type: MemoryType;
  subject: string;
  content: string;
  confidence: "verified" | "inferred";
  sourceFile: string;
  sourceSymbol?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  additionalEvidenceFiles?: string[];
  producer?: "deterministic" | "ai";
  qualityScore?: number | null;
}

export interface PreparedMemoryCandidate {
  candidate: MemoryCandidate;
  evidence: Array<{ sourceFile: string; fileHash: string | null }>;
  sourceHash: string;
}

export interface SyncOptions {
  expectedCommit?: string;
}

export interface DependencyCandidate {
  dependencyType: "npm" | "internal-package" | "http" | "config";
  name: string;
  category: string;
  purpose: string;
  runtime: "server" | "browser" | "mixed" | "unknown";
  configKey?: string | null;
  sourceFile: string;
  sourceSymbol?: string | null;
  startLine?: number | null;
}

export type AnalyzerKind =
  | "repository"
  | "route"
  | "rendering"
  | "api"
  | "cache"
  | "authentication"
  | "middleware"
  | "state"
  | "seo"
  | "analytics"
  | "configuration"
  | "build"
  | "security"
  | "performance"
  | "technical-debt";

export interface ClassifiedFile {
  path: string;
  analyzers: AnalyzerKind[];
  memoryRelevant: boolean;
}

export interface ChangedFile {
  status: string;
  path: string;
  previousPath?: string;
}

export interface SearchResult {
  id: number;
  repository: string;
  type: MemoryType;
  subject: string;
  content: string;
  sourceFile: string | null;
  /** Closest callable/class that owns the primary evidence, when available. */
  sourceSymbol?: string | null;
  commitSha: string | null;
  score: number;
  channels: string[];
  confidence?:string|null;
  qualityScore?:number|null;
  evidenceCount?:number;
  locatedEvidenceCount?:number;
  repositorySha?:string|null;
  relationCoverage?:number;
  queryTypeBoost?:number;
  exactAnchorMatch?:boolean;
  channelRanks?:Partial<Record<"sql"|"fts"|"vector"|"graph",number>>;
  canonicalEntity?:string;
  duplicateIds?:number[];
  sourceFiles?:string[];
  ranking?:{
    score:number;
    features:{taskFit:number;relationCoverage:number;freshness:number;evidenceQuality:number;entitySpecificity:number;channelRelevance:number};
  };
}

export interface RetrievalQuery {
  raw: string;
  repository?: string;
  memoryTypes?: MemoryType[];
  nextMajor?: number;
  route?: string;
  intent: import("./retrieval/intent.js").TaskIntent;
  intentConfidence: import("./retrieval/intent.js").IntentClassification["confidence"];
  channels: Array<"sql" | "fts" | "vector">;
}
