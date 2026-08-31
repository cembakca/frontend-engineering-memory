import type { MemoryCandidate, RepositoryProfile, RouteRecord } from "../types.js";

export function repositoryProfileMemory(profile: RepositoryProfile): MemoryCandidate {
  const facts = [
    `framework=${profile.framework}`,
    `Next.js=${profile.nextVersion ?? "Unknown"}`,
    `React=${profile.reactVersion ?? "Unknown"}`,
    `Node=${profile.nodeVersion ?? "Unknown"}`,
    `router=${profile.routerType}`,
    `packageManager=${profile.packageManager ?? "Unknown"}`,
    `output=${profile.outputMode ?? "Unknown"}`,
  ];
  return {
    type: "repository_profile",
    subject: profile.name,
    content: `${profile.name} repository profile: ${facts.join(", ")}.`,
    confidence: "verified",
    sourceFile: "package.json",
    additionalEvidenceFiles: profile.evidenceFiles.filter((file) => file !== "package.json"),
  };
}

export function routeMemory(route: RouteRecord): MemoryCandidate {
  const strong = route.evidence.length > 0 && !route.evidence.includes("App Router page without detected dynamic trigger");
  return {
    type: "rendering",
    subject: `route:${route.route}`,
    content: `Route ${route.route} (${route.routerType} router, ${route.routeType}) is detected at ${route.sourceFile}; analysis classifies rendering as ${route.renderingMode}${route.cacheBehavior.length ? `; cache: ${route.cacheBehavior.join(", ")}` : ""}${route.backendDependencies.length ? `; backend dependencies: ${route.backendDependencies.join(", ")}` : ""}${route.middlewareMatched ? `; middleware matched by ${route.middlewareMatchers.join(", ") || "default matcher"}` : ""}${route.evidence.length ? `; evidence: ${route.evidence.join(", ")}` : ""}.`,
    confidence: strong ? "verified" : "inferred",
    sourceFile: route.sourceFile,
    additionalEvidenceFiles: route.behaviorFiles.filter((file) => file !== route.sourceFile),
  };
}
