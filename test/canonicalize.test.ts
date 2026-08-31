import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeMemories } from "../src/analyzers/canonicalize.js";
import { isDecisionQuestion } from "../src/retrieval/decision-context.js";
import type { MemoryCandidate } from "../src/types.js";

function config(subject:string,sourceFile:string,content:string):MemoryCandidate {
  return {type:"configuration",subject,content,confidence:"verified",sourceFile,startLine:1};
}

test("collapses a configuration key observed in many files into one fact",()=>{
  const merged=canonicalizeMemories([
    config("GATEWAY_URL",".env.production",".env.production declares configuration key GATEWAY_URL."),
    config("GATEWAY_URL","src/lib/gateway.ts","Configuration key GATEWAY_URL is referenced by src/lib/gateway.ts."),
    config("GATEWAY_URL",".env.test",".env.test declares configuration key GATEWAY_URL."),
    config("GATEWAY_URL","next.config.ts","Configuration key GATEWAY_URL is referenced by next.config.ts."),
  ]);

  assert.equal(merged.length,1,"one key is one fact, however many files mention it");
  const fact=merged[0]!;
  assert.match(fact.content,/read in next\.config\.ts, src\/lib\/gateway\.ts/);
  assert.match(fact.content,/declared in \.env\.production, \.env\.test/);
  assert.equal(fact.sourceFile,"src/lib/gateway.ts","anchored on a source read, not an env declaration");
  assert.deepEqual(fact.additionalEvidenceFiles,[".env.production",".env.test","next.config.ts"]);
});

test("keeps a key that is declared but never read, so dead configuration stays visible",()=>{
  const merged=canonicalizeMemories([
    config("GATEWAY_API_URL",".env.production",".env.production declares configuration key GATEWAY_API_URL."),
    config("GATEWAY_API_URL",".env.test",".env.test declares configuration key GATEWAY_API_URL."),
  ]);
  assert.equal(merged.length,1);
  assert.match(merged[0]!.content,/declared in \.env\.production, \.env\.test/);
  assert.equal(/read in/.test(merged[0]!.content),false,"nothing reads it, so nothing is claimed to");
});

test("never merges types whose subject is the file itself",()=>{
  const cacheOne:MemoryCandidate={type:"cache",subject:"src/a.ts",content:"a revalidates in 900 seconds.",confidence:"verified",sourceFile:"src/a.ts"};
  const cacheTwo:MemoryCandidate={type:"cache",subject:"src/b.ts",content:"b uses no-store.",confidence:"verified",sourceFile:"src/b.ts"};
  const merged=canonicalizeMemories([cacheOne,cacheTwo]);
  assert.equal(merged.length,2,"merging per-file claims would fabricate a fact");
});

test("passes a single occurrence through untouched",()=>{
  const only=config("HOST","src/lib/site-origin.ts","Configuration key HOST is referenced by src/lib/site-origin.ts.");
  assert.deepEqual(canonicalizeMemories([only]),[only]);
});

test("routes a why-question about a choice to the decision store",()=>{
  for (const question of [
    "Ekip neden Next.js 16'yı seçti?",
    "Neden bu kütüphaneyi seçtik?",
    "Bu mimari neden tercih edildi?",
    "Why did we choose Next.js 16?",
    "Why was this library chosen?",
  ]) assert.equal(isDecisionQuestion(question),true,question);
});

test("leaves a why-question about behaviour on the debugging path",()=>{
  for (const question of [
    "Contact form neden `400 Captcha failed` döndürebilir?",
    "Menü neden cache'leniyor?",
    "Why is the build failing?",
    "İletişim formu nasıl gönderiliyor?",
  ]) assert.equal(isDecisionQuestion(question),false,question);
});
