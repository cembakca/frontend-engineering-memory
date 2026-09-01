import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyTaskIntent } from "../src/retrieval/intent.js";
import { understandQuery } from "../src/retrieval/understand.js";

const BASELINE:Array<[string,string]>=[
  ["`/` isteği gerçekte ne yapıyor?","lookup"],
  ["İletişim formu kullanıcı girdisini upstream backend'e hangi sırayla gönderiyor?","explain-flow"],
  ["Contact captcha tokenı nasıl üretilip upstream header'a dönüşüyor?","explain-flow"],
  ["src/lib/legal-pages/manifest.ts değişirse hangi route ve bileşenler etkilenir?","impact"],
  ["Projenin error-handling ve automated-test stratejisi nedir?","verify"],
  ["Bütün aktif HTTP route'larını ve source dosyalarını listele.","lookup"],
  ["Menü hangi upstream endpoint'ten gelir ve cache süresi nedir?","lookup"],
  ["Newsletter aboneliği UI'dan backend'e hangi sırayla gider?","explain-flow"],
  ["Client token refresh isteği handler üzerinden OAuth endpoint'ine nasıl gider?","explain-flow"],
  ["Global menü hangi layout/component zinciriyle tüm sayfalara ulaşır?","explain-flow"],
  ["GATEWAY_URL davranışı değişirse hangi handler, fetch ve route'lar etkilenir?","impact"],
  ["hCaptcha adapter değişirse hangi kullanıcı akışları risklidir; API handler'lar doğrudan etkilenir mi?","impact"],
  ["Yeni captcha korumalı form eklerken hangi mevcut pattern izlenmeli?","implementation-plan"],
  ["Contact form neden `400 Captcha failed` döndürebilir?","debug"],
  ["Working tree dirty ise memory güncel sayılabilir mi?","change-review"],
  ["Ekip neden Next.js 16'yı seçti?","unknown"],
];

test("classifies all 15 baseline questions into task-aware intents",()=>{
  for (const [question,expected] of BASELINE) {
    assert.equal(classifyTaskIntent(question).intent,expected,question);
  }
});

test("classifies the complete 50-question golden catalog",()=>{
  const markdown=readFileSync(new URL("../docs/EVALUATION.md",import.meta.url),"utf8");
  const expected=(id:string):string=>{
    if (id.startsWith("RCE-E")) return "lookup";
    if (id.startsWith("RCE-F")) return "explain-flow";
    if (id.startsWith("RCE-I")) return "impact";
    if (id==="RCE-P07"||id==="RCE-D07") return "verify";
    if (id.startsWith("RCE-P")) return "implementation-plan";
    if (id.startsWith("RCE-D")) return "debug";
    if (/RCE-N0[1-3]/.test(id)) return "change-review";
    if (/RCE-N0[4-6]/.test(id)) return "lookup";
    return "unknown";
  };
  const cases=markdown.split("\n").flatMap((line)=>{
    const match=line.match(/^\| (RCE-[EFIPDN]\d+) \| (.*?) \|/);
    return match ? [{id:match[1]!,question:match[2]!}] : [];
  });
  assert.equal(cases.length,50);
  for (const item of cases) assert.equal(classifyTaskIntent(item.question).intent,expected(item.id),`${item.id}: ${item.question}`);
});

test("supports Turkish and English mixed phrasing",()=>{
  assert.equal(classifyTaskIntent("Bu PR için change review yap, behavior diff nedir?").intent,"change-review");
  assert.equal(classifyTaskIntent("Yeni route eklemek için implementation plan çıkar").intent,"implementation-plan");
  assert.equal(classifyTaskIntent("Which components are affected if this config değişirse?").intent,"impact");
  assert.equal(classifyTaskIntent("Which commands should I run, coverage boşluğu var mı?").intent,"verify");
  assert.equal(classifyTaskIntent("Projenin automated-test ve doğrulama stratejisi nedir?").intent,"verify");
});

test("returns explainable scores and matched signals",()=>{
  const result=classifyTaskIntent("Form UI'dan upstream backend'e hangi sırayla gider?");
  assert.equal(result.intent,"explain-flow");
  assert.equal(result.confidence,"high");
  assert.ok(result.signals.some((signal)=>signal.rule==="ordered-flow"));
  assert.ok((result.scores["explain-flow"] ?? 0)>0);
});

test("abstains on vague and unsupported decision questions",()=>{
  assert.equal(classifyTaskIntent("Buna bir bakar mısın?").intent,"unknown");
  assert.equal(classifyTaskIntent("Ekip neden bu mimariyi seçti?").intent,"unknown");
});

test("understandQuery exposes intent and never parses source files as routes",()=>{
  const impact=understandQuery("src/lib/legal-pages/manifest.ts değişirse ne etkilenir?");
  assert.equal(impact.intent,"impact");
  assert.equal(impact.route,undefined);
  assert.equal(understandQuery("`/iletisim` route'u nerede?").route,"/iletisim");
  assert.equal(understandQuery("`/` isteği gerçekte ne yapıyor?").route,"/");
  assert.equal(understandQuery("https://example.com durumunu kontrol et").route,undefined);
});
