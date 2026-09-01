export type TaskIntent=
  |"lookup"
  |"explain-flow"
  |"impact"
  |"debug"
  |"implementation-plan"
  |"change-review"
  |"verify"
  |"unknown";

export interface IntentSignal {
  intent:Exclude<TaskIntent,"unknown">;
  rule:string;
  weight:number;
  match:string;
}

export interface IntentClassification {
  intent:TaskIntent;
  confidence:"high"|"medium"|"low";
  scores:Partial<Record<Exclude<TaskIntent,"unknown">,number>>;
  signals:IntentSignal[];
  alternatives:TaskIntent[];
  reason:string;
}

interface Rule {
  intent:IntentSignal["intent"];
  name:string;
  weight:number;
  pattern:RegExp;
}

function normalized(raw:string):string {
  return raw.toLocaleLowerCase("tr-TR").normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .replaceAll("ı","i").replaceAll("ş","s").replaceAll("ğ","g").replaceAll("ç","c").replaceAll("ö","o").replaceAll("ü","u");
}

const RULES:Rule[]=[
  {intent:"impact",name:"change-consequence",weight:7,pattern:/\b(?:degisir(?:se)?|degistirirsem|degisiklig\w*|etkilen\w*|etkile(?:r|yebilir)|impact|affected|blast radius)\b/},
  {intent:"impact",name:"risk-surface",weight:6,pattern:/\b(?:hangi\s+(?:route|component|bilesen|handler|akis)(?:lar)?\s+riskli|etki\s+kapsami|route\s+kapsami)\b/},

  {intent:"explain-flow",name:"ordered-flow",weight:7,pattern:/\b(?:hangi sirayla|adim adim|step by step|end[- ]to[- ]end)\b/},
  {intent:"explain-flow",name:"layer-transition",weight:6,pattern:/\b(?:ui(?:'|’)dan|client(?:'|’)dan|formdan|browserdan).{0,40}\b(?:backend|server|upstream)\b/},
  {intent:"explain-flow",name:"chain",weight:6,pattern:/\b(?:akis\w*|flow|zincir\w*|pipeline)\b/},
  {intent:"explain-flow",name:"transformation",weight:5,pattern:/\b(?:nasil).{0,50}\b(?:donus\w*|uretilir|ulasir|baglanir)\b/},
  {intent:"explain-flow",name:"data-origin",weight:5,pattern:/\b(?:iceri[kg]\w*|veri\w*|gorsel\w*).{0,45}\b(?:nereden|nasil).{0,25}\bgelir\b/},

  {intent:"implementation-plan",name:"new-work",weight:9,pattern:/\b(?:yeni|new)\b.{0,70}\b(?:ekle\w*|implement\w*|create|build)\b/},
  {intent:"implementation-plan",name:"edit-plan",weight:7,pattern:/\b(?:nereler|hangi dosyalar|what files)\b.{0,30}\b(?:degismeli|degisecek|change)\b/},
  {intent:"implementation-plan",name:"pattern-plan",weight:6,pattern:/\b(?:hangi mevcut pattern|hangi pattern|implementation plan|uygulama plani|nasil implemente)\b/},
  {intent:"implementation-plan",name:"new-usage",weight:7,pattern:/\b(?:yeni|new)\b.{0,70}\b(?:dogru yol|how should|kullanimi)\b/},

  {intent:"debug",name:"failure-cause",weight:7,pattern:/\b(?:neden|why)\b.{0,70}\b(?:failed|fail|error|hata|bozuk|unreachable|unavailable|configured|dondu|dondurur|dondurebilir|yanlis)\b/},
  {intent:"debug",name:"status-failure",weight:7,pattern:/\b(?:4\d\d|5\d\d|exception|stack trace|captcha failed|upstream unreachable|not configured)\b/},
  {intent:"debug",name:"troubleshoot",weight:6,pattern:/\b(?:debug|troubleshoot|kok neden|root cause|kontrol edilmeli|check first)\b/},
  {intent:"debug",name:"broken-state",weight:8,pattern:/\b(?:bozuk\w*|broken|calismiyor|eksik|missing|unavailable)\b/},

  {intent:"verify",name:"verification-commands",weight:8,pattern:/\b(?:hangi komutlar|what commands|verification commands?|dogrulama adimlari|nasil dogrular)\b/},
  {intent:"verify",name:"test-coverage",weight:8,pattern:/\b(?:automated[- ]test|test stratejisi|test strategy|dogrulama stratejisi|test boslugu|coverage gap|coverage boslugu|hangi testler)\b/},
  {intent:"verify",name:"quality-gate",weight:6,pattern:/\b(?:lint|typecheck|type-check|test suite|ci checks?|quality gate)\b/},

  {intent:"change-review",name:"revision-diff",weight:8,pattern:/\b(?:diff|change review|degisiklik incele|review (?:this |the )?(?:change|pr)|before.{0,20}after)\b/},
  {intent:"change-review",name:"since-revision",weight:8,pattern:/\b(?:sonrasinda|since)\b.{0,60}\b(?:ne degisti|neler degisti|changed|davranis\w*)\b/},
  {intent:"change-review",name:"snapshot-state",weight:6,pattern:/\b(?:working tree|indexed sha|target head|hedef head|commit sha|hangi sha|memory guncel|freshness|stale)\b/},

  {intent:"lookup",name:"inventory",weight:5,pattern:/\b(?:listele|list all|inventory|hangi route\w*|which routes|hangi handler\w*|which handlers)\b/},
  {intent:"lookup",name:"exact-location",weight:4,pattern:/\b(?:nerede|where|hangi dosya\w*|which file|hangi endpoint\w*|which endpoint|hangi surum\w*|what version|nedir|what is)\b/},
  {intent:"lookup",name:"source-lookup",weight:4,pattern:/\b(?:hangi kaynaklardan|which sources|nereden tanimlanir)\b/},
  {intent:"lookup",name:"direct-behaviour",weight:4,pattern:/\b(?:gercekte ne yapiyor|what does .{0,30} do|kabul ediyor|kullaniliyor mu|does .{0,30} use)\b/},
];

/** Deterministic, explainable task-intent classification for Turkish/English mixed queries. */
export function classifyTaskIntent(raw:string):IntentClassification {
  const text=normalized(raw);
  const scores:IntentClassification["scores"]={};
  const signals:IntentSignal[]=[];
  for (const rule of RULES) {
    const match=rule.pattern.exec(text);
    if (!match) continue;
    scores[rule.intent]=(scores[rule.intent] ?? 0)+rule.weight;
    signals.push({intent:rule.intent,rule:rule.name,weight:rule.weight,match:match[0]});
  }
  const ranked=(Object.entries(scores) as Array<[Exclude<TaskIntent,"unknown">,number]>)
    .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  const first=ranked[0];
  if (!first||first[1]<4) {
    return {intent:"unknown",confidence:"low",scores,signals,alternatives:ranked.map(([intent])=>intent),
      reason:"no intent reached the minimum evidence threshold"};
  }
  const second=ranked[1];
  if (second&&second[1]===first[1]) {
    return {intent:"unknown",confidence:"low",scores,signals,alternatives:[first[0],second[0]],
      reason:`ambiguous tie between ${first[0]} and ${second[0]}`};
  }
  const margin=first[1]-(second?.[1] ?? 0);
  const confidence=first[1]>=7&&margin>=3 ? "high" : margin>=2 ? "medium" : "low";
  return {intent:first[0],confidence,scores,signals,alternatives:ranked.slice(1,3).map(([intent])=>intent),
    reason:`${first[0]} leads by ${margin} point${margin===1 ? "" : "s"}`};
}
