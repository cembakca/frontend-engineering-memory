# RCE-017 — Typed context-pack şemaları

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/retrieval/context-pack.ts`](../src/retrieval/context-pack.ts)  
**Test:** [`test/context-pack.test.ts`](../test/context-pack.test.ts) — 6 vaka  
**Durum:** beş intent-specific, evidence-bearing ve bütçeli schema

## 1. Tek generic item listesi neden yetmiyor?

Flow sorusu sıra ve boundary ister; impact sorusu ters relation ve affected yüzeyi; implementation sorusu exemplar, edit surface ve doğrulama boşluğu ister. Hepsini `{subject, fact, file}` listesine çevirmek RCE-002'deki “parçaları buldu ama ilişkiyi kuramadı” sonucunu yeniden üretir.

Compiler bu nedenle `kind` ile ayrılan beş schema döndürür:

```ts
type ContextPack =
  | FlowContextPack
  | ImpactContextPack
  | ImplementationContextPack
  | DebugContextPack
  | ChangeReviewContextPack;
```

Ortak alanlar yalnız gerçekten ortak olan metadata'dır: `schemaVersion`, `kind`, `query`, `repository`, `snapshotSha`, `budget`, `answerContract`. RCE-018 ile gap ve source fallback, belirsizlik nedeni ve kullanım kuralıyla birlikte `answerContract` altında structured hale geldi.

## 2. Schema yüzeyleri

### Flow

```text
seed
steps[]: order, depth, relation, from, to, boundary?, evidence
endpoints[]
config[]
prunedSteps
```

Client→server sınırı ve execution order kaybolmaz. Her step kendi file/line/symbol/confidence evidence'ını taşır.

### Impact

```text
seed
affected: routes, apiRoutes, components, files, config, endpoints, tests
relations[]: depth, affected, kind, relation, dependency, evidence
```

Affected summary cevap için küçük yüzeydir; `relations` her etkinin nedenini doğrular.

### Implementation

```text
exemplars[]: canonical entity, type, fact, evidence, rank score
editSurface: files, routes, components, config
verification: commands, tests, gaps
```

Plan yalnız benzer source'u göstermez; muhtemel edit yüzeyi ve çalıştırılabilir doğrulama/coverage boşluğunu aynı pack'te tutar.

### Debug

```text
facts[]
failurePath[]: ordered relation + evidence
checks[]
endpoints[]
config[]
```

`checks` caller tarafından source-backed olarak sağlanır; compiler kendi başına root cause veya çözüm uydurmaz.

### Change review

```text
changes[]: operation, entity, file, fromSha, toSha
affected: routes, apiRoutes, components, files, tests
verification: commands, tests, gaps
```

Dosya diff'i, davranış impact'i ve test yüzeyi ayrı alanlardır; bir dosya listesi behavior change gibi sunulmaz.

## 3. Evidence sözleşmesi

Fact, flow step, impact relation, verification command ve test vakası şu küçük evidence biçimini kullanır:

```ts
{ file: string; line: number|null; symbol: string|null; confidence: string|null }
```

Pack compiler confidence üretmez; analyzer/ranker'dan gelen değeri taşır. Evidence olmayan exemplar boş array ile görünür, kanıt varmış gibi doldurulmaz.

RCE-018 karışık fact/inference listelerindeki öğelere `claimKind` ekler. Türü section tarafından zaten kesin olan graph adımları compact tutulur ve top-level `answerContract.derivedRelations` selector'ıyla `derived-relation` olarak işaretlenir. Source-backed retrieval kayıtları `fact`, confidence değeri `inferred` olan kayıtlar `inference` olur. Ayrıntı için [`REPOSITORY_CONTEXT_ENGINE_ANSWER_CONTRACT.md`](REPOSITORY_CONTEXT_ENGINE_ANSWER_CONTRACT.md) belgesine bakın.

## 4. Bütçe sözleşmesi

```ts
interface PackBudget {
  maxChars: number;
  usedChars: number;
  estimatedTokens: number;
  truncated: boolean;
  omitted: Record<section,number>;
}
```

- `maxChars` 1.000–24.000 aralığına clamp edilir; varsayılan 8.000.
- JSON string'i sonradan körlemesine kesilmez; schema her zaman geçerli kalır.
- Bir array item bütçeyi aşarsa eklenmez ve kendi bölümünün `omitted` sayacı artar.
- `usedChars` final serialized pack'in gerçek uzunluğudur.
- `estimatedTokens = ceil(chars/3.5)` yalnız engine tahminidir; billed/model token iddiası değildir.
- Selector ve final budget-counter büyümesi için 240 karakter reserve bırakılır.

Traversal kendisi kesilmişse neden `answerContract.uncertainty` içine yazılır; payload truncation ile graph truncation birbirine karışmaz.

## 5. RCE-017 pilot 8k baseline'ı

| Vaka | Schema | Karakter | ~Token | Truncated |
| --- | --- | ---: | ---: | --- |
| F01 contact | flow | 5.786 | 1.654 | hayır |
| I02 `GATEWAY_URL` | impact | 6.060 | 1.732 | hayır |
| P03 captcha form | implementation | 5.820 | 1.663 | hayır |
| D01 captcha 400 | debug | 7.016 | 2.005 | hayır |

Dört farklı schema varsayılan 8.000 karakter bütçesine relation/evidence kaybetmeden sığdı. Bu sayılar source read veya billed context değildir; yalnız serialized pack maliyetidir.

Bu tablo RCE-017'nin answer contract eklenmeden önceki baseline'ıdır. RCE-018 sonrası güncel ölçüm answer-contract belgesinde ayrıca kayıtlıdır; iki şema sürümünün payload rakamları birbirine karıştırılmaz.

## 6. RCE-018/RCE-019 entegrasyonu

RCE-018 fact/derived/inference/uncertainty dilini `answerContract` ile standardize etti. RCE-019 MCP yüzeyi typed compiler'ı `memory_context` adlı tek task-aware giriş noktası olarak kullanır.
