# RCE-015 — Query plan

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/retrieval/query-plan.ts`](../src/retrieval/query-plan.ts)  
**Search entegrasyonu:** [`src/retrieval/search.ts`](../src/retrieval/search.ts)  
**Test:** [`test/query-plan.test.ts`](../test/query-plan.test.ts) — 6 vaka  
**Durum:** intent-aware iki turlu retrieval planı

## 1. Plan sözleşmesi

```ts
interface QueryPlan {
  raw: string;
  intent: TaskIntent;
  intentConfidence: "high" | "medium" | "low";
  anchors: { route?; files; symbols; config };
  memoryTypes: MemoryType[];
  memoryTypeMode: "filter" | "boost" | "none";
  rounds: QueryPlanRound[];
  secondRoundTriggers: SecondRoundTrigger[];
  stopWhen: string[];
  abstainWhen: string[];
}
```

Her step kanal, operasyon, amaç, sonuç limiti, karakter bütçesi ve zorunluluk bilgisi taşır. Plan retrieval sonucunun kendisi değildir; yürütücünün neyi neden ve hangi sırayla çağıracağını belirleyen typed sözleşmedir.

## 2. Intent → kanal sırası

| Intent | Birinci tur | Koşullu ikinci tur |
| --- | --- | --- |
| `lookup` | structured anchor/envanter varsa exact SQL; aksi halde FTS | FTS → vector |
| `explain-flow` | exact seed resolution → flow traversal | FTS → targeted source |
| `impact` | exact entity resolution → reverse impact traversal | FTS → targeted source |
| `debug` | exact failure surface → flow traversal → FTS | vector → targeted source |
| `implementation-plan` | FTS exemplar → exemplar flow → verification graph | vector → impact → targeted source |
| `change-review` | change audit → impact → verification graph | targeted diff/source |
| `verify` | verification graph → target inventory | package/CI/test source |
| `unknown` | küçük ve opsiyonel exact/FTS discovery | yalnız explicit anchor source; aksi halde abstain |

Graph gerektiren intent'lerde FTS birinci kanal değildir. Bu, RCE-002'de flow ve impact sorularının bağımsız memory parçaları içinde kaybolmasını engeller.

## 3. Anchor çıkarımı

Plan sorgudan dört structured anchor türü çıkarır:

- HTTP route: `/`, `/iletisim`, `/api/...`
- repository file: `src/lib/menu.ts`
- symbol identity: `src/lib/menu.ts#getMenuList`
- config: `GATEWAY_URL`

`UI`, `API`, `HTTP`, `SHA`, `URL` gibi genel büyük harfli teknik terimler config sayılmaz. Exact route değeri bulunmasa bile “bütün route'ları listele”, repository veya version inventory soruları structured SQL planına gider.

## 4. İkinci tur karar sözleşmesi

İkinci tur varsayılan olarak çalışmaz. `decideSecondRound` yalnız planın kabul ettiği ölçülebilir sinyalleri değerlendirir:

```text
empty                  resultCount == 0
missing-evidence       evidenceCount == 0
missing-relations      relationCoverage < 1
unresolved-anchor      en az bir route/file/symbol/config çözülemedi
truncated              graph veya payload bütçesi sonucu kesti
low-intent-confidence  RCE-014 confidence low
```

Örneğin impact sonucu dört evidence ve tam relation coverage ile döndüyse ikinci tur açılmaz. Aynı sonuçta `GATEWAY_URL` çözülememiş veya closure %50 kalmışsa FTS + targeted source turu açılır.

Bu ayrım context ekonomisi için zorunludur: vector ve source fallback'i her soruda eager çalıştırmak RCE-004'ün sabit/etkin maliyet sorununu yeniden üretirdi.

## 5. Memory type: filter değil boost

Eski davranış, sorguda `cache`, `config` veya `api` kelimesi görülünce inferred memory tiplerini SQL şartına ve vector filtresine çeviriyordu. RCE-003'te ilk 15 vakanın 6'sında bu filtre aktifti; F03 başta olmak üzere doğru tipte memory yoksa pack tamamen boşalıyordu.

Yeni kural:

| Kaynak | `memoryTypeMode` | Davranış |
| --- | --- | --- |
| Kullanıcı/MCP açıkça `types` gönderdi | `filter` | FTS ve vector hard filter |
| Query parser otomatik tip çıkardı | `boost` | Sonuç kümesi daralmaz; eşleşen tipe +0,2 ranking bonusu |
| Tip sinyali yok | `none` | Tip etkisi yok |

Bu politika mevcut hybrid search'e uygulandı; yalnız gelecekteki plan yürütücüsüne bırakılmadı.

## 6. İlk 15 vaka ölçümü

| İlk kanal | Vaka sayısı |
| --- | ---: |
| exact SQL | 10 |
| FTS | 3 |
| verification graph | 1 |
| change audit | 1 |

Flow vakalarının 4/4'ü `exact-sql → graph-flow`, impact vakalarının 3/3'ü `exact-sql → graph-impact` planı aldı. Debug vakası failure flow'a, implementation vakası exemplar+verification planına gitti. Altı otomatik tip sinyalinin tamamı `boost`; hard filter olan otomatik vaka sayısı 0.

## 7. Stop ve abstain

Plan şu koşullarda durmayı söyler: gerekli anchor'lar çözülmüş, her factual item evidence taşıyor, gerekli relation coverage tam ve payload bütçesi aşılmamış.

İkinci turdan sonra hâlâ anchor eksikse, istek repository evidence kapsamı dışındaysa veya decision/why iddiası human-approved provenance taşımıyorsa plan cevap uydurmak yerine abstain eder.

## 8. Açık sınır

Bu madde typed planı ve ikinci tur kararını üretir. Kanalların sonuçlarını kanonik entity üzerinde birleştirmek ve sıralamak RCE-016; intent'e özel token-budgeted payload'a çevirmek RCE-017 kapsamıdır.
