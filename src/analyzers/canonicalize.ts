import type { MemoryCandidate, MemoryType } from "../types.js";

/**
 * RCE-005, applied at the memory level.
 *
 * A configuration key referenced in six files is one fact with six occurrences,
 * not six facts. Storing it six times inflates the index and, worse, spends six
 * of the five slots a bounded pack can return.
 *
 * Only types whose `subject` names a repository-wide entity are merged. For
 * `cache`, `seo` or `api_dependency` the subject is the file itself, so grouping
 * would be a no-op and merging their contents would fabricate a claim.
 */
const CANONICAL_TYPES=new Set<MemoryType>(["configuration","dependency","shared_package"]);

function isEnvFile(file:string):boolean { return /(^|\/)\.env/.test(file); }

/** Files, in a stable order, without repeating the anchor. */
function others(files:string[],anchor:string):string[] {
  return [...new Set(files)].filter((file)=>file!==anchor).sort();
}

function mergeConfiguration(subject:string,group:MemoryCandidate[]):MemoryCandidate {
  const files=[...new Set(group.map((item)=>item.sourceFile))];
  const declaredIn=files.filter(isEnvFile).sort();
  const readIn=files.filter((file)=>!isEnvFile(file)).sort();
  // Anchor on a source read when there is one: where a key is used carries more
  // than where it is declared, and the evidence line then points at behaviour.
  const anchor=group.find((item)=>!isEnvFile(item.sourceFile)) ?? group[0]!;

  const parts:string[]=[];
  if (readIn.length) parts.push(`read in ${readIn.join(", ")}`);
  if (declaredIn.length) parts.push(`declared in ${declaredIn.join(", ")}`);

  return {
    ...anchor,
    content:`Configuration key ${subject} is ${parts.join("; ")}.`,
    additionalEvidenceFiles:others([...(anchor.additionalEvidenceFiles ?? []),...files],anchor.sourceFile),
  };
}

function mergeGeneric(group:MemoryCandidate[]):MemoryCandidate {
  const anchor=group[0]!;
  const files=group.flatMap((item)=>[item.sourceFile,...(item.additionalEvidenceFiles ?? [])]);
  return {...anchor,additionalEvidenceFiles:others(files,anchor.sourceFile)};
}

interface Group { type:MemoryType; subject:string; items:MemoryCandidate[] }

export function canonicalizeMemories(candidates:MemoryCandidate[]):MemoryCandidate[] {
  const out:MemoryCandidate[]=[];
  const groups=new Map<string,Group>();
  const order:string[]=[];

  for (const candidate of candidates) {
    if (!CANONICAL_TYPES.has(candidate.type)) { out.push(candidate); continue; }
    const key=`${candidate.type}|${candidate.subject}`;
    const bucket=groups.get(key);
    if (bucket) bucket.items.push(candidate);
    else { groups.set(key,{type:candidate.type,subject:candidate.subject,items:[candidate]}); order.push(key); }
  }

  for (const key of order) {
    const group=groups.get(key)!;
    if (group.items.length===1) { out.push(group.items[0]!); continue; }
    out.push(group.type==="configuration" ? mergeConfiguration(group.subject,group.items) : mergeGeneric(group.items));
  }
  return out;
}
