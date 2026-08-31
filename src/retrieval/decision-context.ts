import type { MemoryStore } from "../memory/store.js";
import { createAnswerContract } from "./answer-contract.js";

/**
 * A "why" question is only a decision question when it asks about a *choice*.
 *
 * The discriminator matters: "neden `400 Captcha failed` döndürebilir?" also
 * starts with neden but asks about behaviour, and routing it to the decision
 * store would lose a debuggable answer. So a choice verb is required, and the
 * verb list has to cover Turkish person and voice endings — the first version
 * matched only `seçtik` and missed `seçti`, which is why RCE-N07 returned five
 * unrelated configuration facts instead of abstaining.
 */
const TURKISH_WHY=/\b(?:neden|niçin|nicin|niye)\b/i;
const TURKISH_CHOICE=/(?:se[çc](?:ti|tik|tiler|ildi|ilmiş|ilmis|im|iyoruz)|tercih|karar\s*ver|ge[çc](?:tik|ildi|ti))/i;
const ENGLISH_CHOICE=/\bwhy\s+(?:did|do|does|was|were|is|are|has|have)\b[\s\S]{0,40}?(?:choose|chosen|choosing|use|using|adopt|adopted|pick|picked|prefer|switch)/i;

export function isDecisionQuestion(question:string):boolean {
  if (/\b(?:hangi karar|decision record|rationale|gerekçe|adr)\b/i.test(question)) return true;
  if (ENGLISH_CHOICE.test(question)) return true;
  return TURKISH_WHY.test(question)&&TURKISH_CHOICE.test(question);
}

export function buildDecisionContext(store:MemoryStore,repository:string,question:string,maxChars=8_000):any {
  const decisions=store.listRepositoryDecisions(repository,question).filter((item)=>item.status==="accepted").slice(0,10);
  const pack:any={schemaVersion:"1.0",kind:"decision",repository,query:question,decisions,answerContract:createAnswerContract({}),
    budget:{maxChars,usedChars:0,estimatedTokens:0,truncated:false,omitted:{}}};
  const rebuild=()=>{ pack.answerContract=createAnswerContract({facts:decisions.length ? ["decisions"] : [],empty:!decisions.length,
    uncertainty:decisions.length ? [] : ["no human-approved ADR, PR, issue or decision record supports a why answer"],truncated:pack.budget.truncated}); };
  rebuild();
  while (JSON.stringify(pack).length>maxChars&&decisions.length) {
    decisions.pop();pack.budget.truncated=true;pack.budget.omitted.decisions=(pack.budget.omitted.decisions ?? 0)+1;
    rebuild();
  }
  for (let index=0;index<3;index+=1) { pack.budget.usedChars=JSON.stringify(pack).length; pack.budget.estimatedTokens=Math.ceil(pack.budget.usedChars/3.5); }
  return pack;
}
