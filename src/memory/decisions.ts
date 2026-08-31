export type DecisionSourceKind="adr"|"pr"|"issue"|"human";
export type DecisionStatus="proposed"|"accepted"|"rejected";

export interface DecisionInput {
  key:string;
  title:string;
  rationale:string;
  status:DecisionStatus;
  sourceKind:DecisionSourceKind;
  sourceRef:string;
  sourceSha?:string;
  approvedBy:string;
  approvedAt:string;
  supersedesKey?:string;
}

export function validateDecision(input:DecisionInput):DecisionInput {
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/i.test(input.key)) throw new Error("Decision key must be 3-80 stable identifier characters");
  if (input.title.trim().length<3) throw new Error("Decision title is required");
  if (input.rationale.trim().length<10) throw new Error("Decision rationale must come from an approved source and be at least 10 characters");
  if (!input.sourceRef.trim()) throw new Error("Decision sourceRef is required");
  if (input.sourceKind==="adr"&&!/\.md(?:#|$)/i.test(input.sourceRef)) throw new Error("ADR decisions must reference a Markdown ADR");
  if (input.sourceSha&&!/^[0-9a-f]{40}$/i.test(input.sourceSha)) throw new Error("Decision sourceSha must be a full Git SHA");
  if (!input.approvedBy.trim()) throw new Error("Decision approvedBy is required; source code cannot approve rationale");
  if (!Number.isFinite(Date.parse(input.approvedAt))) throw new Error("Decision approvedAt must be an ISO date/time");
  return {...input,title:input.title.trim(),rationale:input.rationale.trim(),sourceRef:input.sourceRef.trim(),approvedBy:input.approvedBy.trim()};
}
