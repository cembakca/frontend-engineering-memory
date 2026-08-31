export type ClaimKind="fact"|"derived-relation"|"inference";
export type UncertaintyLevel="none"|"partial"|"insufficient";

export interface MissingEvidence {
  path:string;
  reason:string;
}

export interface SourceFallback {
  file:string;
  reason:string;
  priority:number;
}

export interface AnswerContract {
  facts:string[];
  derivedRelations:string[];
  inferences:string[];
  uncertainty:{level:UncertaintyLevel;reasons:string[]};
  missingEvidence:MissingEvidence[];
  sourceFallback:SourceFallback[];
  rules:{fact:string;derivedRelation:string;inference:string};
}

export interface AnswerContractInput {
  facts?:string[];
  derivedRelations?:string[];
  inferences?:string[];
  uncertainty?:string[];
  missingEvidence?:MissingEvidence[];
  sourceFallback?:string[];
  truncated?:boolean;
  empty?:boolean;
}

function unique(values:string[]):string[] { return [...new Set(values.filter(Boolean))]; }

export function claimKindForConfidence(confidence:string|null|undefined):"fact"|"inference" {
  return confidence==="inferred" ? "inference" : "fact";
}

/** A compact, machine-readable contract for how an agent may use the payload. */
export function createAnswerContract(input:AnswerContractInput):AnswerContract {
  const missingEvidence=(input.missingEvidence ?? []).filter((item,index,all)=>
    all.findIndex((other)=>other.path===item.path&&other.reason===item.reason)===index);
  const reasons=unique([
    ...(input.uncertainty ?? []),
    ...(input.truncated ? ["context budget or traversal omitted results"] : []),
    ...(missingEvidence.length ? ["one or more claims lack direct evidence"] : []),
    ...((input.inferences?.length ?? 0)>0 ? ["payload contains inference claims"] : []),
  ]);
  const level:UncertaintyLevel=input.empty ? "insufficient" : reasons.length ? "partial" : "none";
  const fallbackReason=missingEvidence.length ? "missing-evidence"
    : input.truncated ? "truncated-context"
    : reasons.length ? "uncertainty"
    : "implementation-detail";
  return {
    facts:unique(input.facts ?? []),
    derivedRelations:unique(input.derivedRelations ?? []),
    inferences:unique(input.inferences ?? []),
    uncertainty:{level,reasons},
    missingEvidence,
    sourceFallback:unique(input.sourceFallback ?? []).map((file,index)=>({file,reason:fallbackReason,priority:index+1})),
    rules:{
      fact:"Cite evidence.",
      derivedRelation:"Qualify as static analysis.",
      inference:"Label; never state as fact.",
    },
  };
}
