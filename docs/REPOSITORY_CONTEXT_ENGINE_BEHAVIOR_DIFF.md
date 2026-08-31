# RCE-020 — Behavior diff

Behavior diff iki başarılı **indexed SHA snapshot'ını** karşılaştırır; Git'in değişen dosya listesi cevap değildir.

Her index transaction'ı şunların immutable JSON görünümünü `repository_snapshots` tablosuna yazar:

- route behavior: rendering, auth, middleware, cache, data source, backend dependency ve SEO;
- active dependencies ve facts;
- evidence-bearing symbol/component graph edges.

`src/retrieval/temporal.ts` iki snapshot'tan beş yüzey üretir:

| Alan | Anlamı |
| --- | --- |
| `routeChanges` | Eklenen/silinen route veya değişen behavior field'ları |
| `flowChanges` | Eklenen/silinen calls/renders/reads/fetches/submits-to/references/delegates-to edge'leri |
| `configChanges` | Config key'i okuyan symbol kümesinin before/after farkı |
| `apiChanges` | Endpoint caller kümesinin before/after farkı |
| `factChanges` | Kanonik type+subject fact'inin eklenmesi, silinmesi veya content değişimi |

Her flow farkı source file/line/symbol/confidence evidence'ı taşır. Pack karakter bütçesini aşarsa düşük öncelikli ayrıntıları section bazında düşürür ve `budget.omitted` ile `answerContract.uncertainty` bunu bildirir.

```bash
npm run memory -- behavior-diff repo --from=<indexed-sha> --to=<indexed-sha>
```

MCP karşılığı aynı üç-tool yüzeyini korur:

```json
{"repository":"repo","question":"Ne değişti?","atSha":"<from>","compareToSha":"<to>"}
```

İki SHA'dan biri indekslenmemişse engine HEAD veya en yakın snapshot'a düşmez; açık hata verir.
