# RCE-018 — Answer contract

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/retrieval/answer-contract.ts`](../src/retrieval/answer-contract.ts), [`src/retrieval/context-pack.ts`](../src/retrieval/context-pack.ts), [`src/retrieval/context.ts`](../src/retrieval/context.ts)  
**Test:** [`test/context-pack.test.ts`](../test/context-pack.test.ts), [`test/mcp.test.ts`](../test/mcp.test.ts)  
**Durum:** typed ve lookup pack'lerinde ortak, makine-okunur cevap sınırı

## 1. Problem

Evidence taşımak tek başına agent'ın doğru epistemik dili kullanmasını sağlamıyor. Önceki pack bir graph relation'ını veya düşük güvenli retrieval kaydını doğrudan fact gibi konuşmaya açıktı; `gaps` ile source dosyaları da birbirinden kopuktu. Answer contract şu soruları payload'ın içinde cevaplar:

- Hangi alan source-backed fact?
- Hangi alan statik analizden türetilmiş relation?
- Hangi alan inference olarak açıkça etiketlenmeli?
- Cevap için evidence yeterli mi?
- Yetmiyorsa tam olarak ne eksik ve hangi dosya hedefli açılmalı?

## 2. Şema

```ts
interface AnswerContract {
  facts: string[];
  derivedRelations: string[];
  inferences: string[];
  uncertainty: {
    level: "none" | "partial" | "insufficient";
    reasons: string[];
  };
  missingEvidence: Array<{ path: string; reason: string }>;
  sourceFallback: Array<{ file: string; reason: string; priority: number }>;
  rules: {
    fact: string;
    derivedRelation: string;
    inference: string;
  };
}
```

Claim listeleri compact JSON selector taşır. Örneğin `facts: ["items[claimKind=fact]"]` lookup listesindeki fact öğelerini, `derivedRelations: ["steps", "endpoints"]` flow pack'indeki statik ilişki alanlarını gösterir. Fact ve inference'ın karışabildiği listelerde öğe kendi `claimKind` değerini de taşır; tamamı aynı sınıfta olan graph section'larında selector tek otoritedir ve tekrar eden metadata payload'ı şişirmez.

## 3. Claim sınıfları

| Sınıf | Üreten yüzey | Agent dili |
| --- | --- | --- |
| `fact` | Located retrieval kaydı, verification command/test, change audit | Evidence cite ederek doğrudan belirt |
| `derived-relation` | Flow step, impact relation, affected/edit surface özeti | Statik analiz ilişkisi olarak nitele; runtime kanıtı deme |
| `inference` | `confidence: inferred` retrieval kaydı | Açıkça inference de; fact olarak sunma |

Graph edge'in `confidence: observed` olması edge'in source AST'de doğrudan görülmesi demektir; yine de uçlar arası cevap ilişkisi `derived-relation` sınıfında kalır. Böylece “source'da bir fetch çağrısı var” ile “bu değişiklik şu route'u etkiler” aynı epistemik sınıfa girmez.

## 4. Belirsizlik yükseltme kuralları

| Sinyal | Sonuç |
| --- | --- |
| Evidence ve gap yok | `none` |
| Inference, verification gap, eksik located evidence veya truncation var | `partial` |
| Hiç kullanılabilir fact/relation/inference yok | `insufficient` |

`missingEvidence` yalnız “bir şey eksik” demez; JSON path/target ile nedeni eşler. Verification graph'ın `missing-test-command`, `missing-test-files` ve `unvalidated-target` gap'leri contract'a taşınır. Boş/unresolved traversal agent'a cevap varmış izlenimi vermez.

## 5. Source fallback

Fallback artık çıplak dosya listesi değildir:

```json
{
  "file": "src/token.ts",
  "reason": "missing-evidence",
  "priority": 1
}
```

Dosyalar dedupe edilir ve retrieval sırasına göre önceliklenir. Compact reason kodu `missing-evidence`, `truncated-context`, `uncertainty` veya `implementation-detail` değerlerinden biridir. Agent yalnız `uncertainty` kaldığında bu listeyi hedefli açar; liste tüm repository'yi tarama yetkisi değildir.

## 6. Bütçe ve regresyonlar

Answer contract zorunlu metadata'dır; düşük öncelikli payload item'larından önce bütçe rezervi alır ve truncation sinyaline kendisi de bakar. Lookup compiler metadata'yı sonradan eklemez: `schemaVersion`, intent ve snapshot dahil nihai JSON aynı karakter bütçesi içinde oluşturulur.

Doğrulanan durumlar:

- Source-backed flow relation'ı `derived-relation`, belirsizlik `none`.
- Verification gap'i `partial` ve structured missing evidence.
- Evidence'sız inferred debug kaydı `inference`, `partial` ve gerekçeli fallback.
- Boş impact traversal'ı `insufficient`.
- 1.200 karakterlik MCP lookup pack'i fact'i koruyarak nihai serialized sınır içinde kalır.
- 1.000 karakter typed pack geçerli JSON ve zorunlu answer contract üretmeye devam eder.

Tek adımlı flow fixture'ı contract dahil 802 karakter/~230 estimated tokendır. Bu model token ölçümü değil, repository'nin ortak `chars/3.5` payload tahminidir.

### Güncel 8k pilot

RCE-017'de kullanılan dört soru güncel task compiler ve answer contract ile yeniden ölçüldü:

| Vaka | Kind | Karakter | ~Token | Uncertainty | Omitted |
| --- | --- | ---: | ---: | --- | --- |
| F01 contact flow | flow | 7.805 | 2.230 | none | 0 |
| I02 `GATEWAY_URL` | impact | 7.431 | 2.124 | none | 0 |
| P03 captcha form | implementation | 7.987 | 2.282 | partial | 18 answer-contract entry |
| D01 captcha 400 | debug | 4.100 | 1.172 | none | 0 |

P03'te implementation exemplar/edit surface korunur; repository'de test runner/test dosyası bulunmamasından doğan uzun verification-gap ve fallback listesi bütçeye sığmayan 18 contract ayrıntısını düşürür. Pack bu durumu `budget.truncated`, `budget.omitted.answerContract` ve `uncertainty: partial` ile açıkça bildirir. Diğer üç pilot relation/fact veya contract kaybetmeden sığar.
