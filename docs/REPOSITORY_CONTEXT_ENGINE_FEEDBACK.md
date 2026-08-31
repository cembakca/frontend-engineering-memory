# RCE-025 — Answer feedback loop

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/telemetry/answer-feedback.ts`](../src/telemetry/answer-feedback.ts)  
**Test:** [`test/answer-feedback.test.ts`](../test/answer-feedback.test.ts) — 8 vaka  
**Yüzeyler:** `pnpm memory feedback add|backlog|triage`, `POST /feedback`, `GET /feedback`

## 1. Tasarım ilkesi: sinyal sayaç değil, vaka üretir

Sayacı artıran bir sinyal hiçbir şeyi değiştirmez. Bu döngüdeki her sinyal tek bir çıktıya doğru itilir: **RCE-002 suite'inin zaten tükettiği biçimde bir taslak evaluation vakası.** Böylece bir şikâyet anekdot değil, çalıştırılabilir bir test olur.

Dört sinyal:

| Sinyal | Anlamı | Backlog'a girer mi |
| --- | --- | --- |
| `sufficient` | Pack yetti | Hayır — pozitif kontrol olarak saklanır |
| `source-needed` | Pack yetmedi, source açmak gerekti | Evet |
| `wrong` | Cevap yanlıştı | Evet |
| `stale` | Cevap eski snapshot'ı yansıtıyordu | Evet |

## 2. MCP yüzeyi büyütülmedi

RCE-004 tool tanımlarının oturum başına sabit maliyetini ölçtü (9 tool = 1.537 token). Bu nedenle geri bildirim için **dördüncü bir MCP tool'u eklenmedi.**

Bunun yerine `memory_context` artık pack'e tek bir alan ekliyor:

```jsonc
{ "kind": "flow", ..., "telemetryEventId": 42 }
```

Rapor daha sonra bu id'yi göstererek tam olarak o retrieval'ı işaret edebiliyor. Ek tool maliyeti sıfır. Raporlama CLI ve HTTP üzerinden yapılıyor — asıl üretici zaten insan değerlendirici veya CI, oturum ortasındaki agent değil.

## 3. Event id olmadan da çalışır

Rapor `--event` yerine yalnız soruyla verilebilir. Bu durumda soru, telemetriyle **aynı** şekilde hash'lenir ve aynı repository'deki en son eşleşen retrieval olayına bağlanır:

```text
feedback add ... --signal=wrong --query="Değişiklikten sonra hangi komutları çalıştırmalıyım?"
```

Bu, ilk uygulamada eksikti: rapor kaydediliyordu ama `retrieval` bloğu tamamen `null` geliyordu, çünkü join yalnız `retrieval_event_id` üzerindeydi. `query_hash`'in varlık nedeni tam olarak gruplamaktı; bağlama artık kayıt anında yapılıyor.

## 4. Sahip yönlendirmesi sinyalden değil, nedenden türetilir

İlk versiyonda sahip haritası sinyal bazlıydı ve `wrong` her zaman analyzer'a gidiyordu. Bu, gerçek bir vakada yanlış çıktı: telemetrinin bulduğu *"Değişiklikten sonra hangi komutları çalıştırmalıyım?"* sorusu `unknown` sınıflandırılmıştı — bu bir analyzer hatası değil, **intent modeli** hatası.

Yönlendirme artık retrieval'ın kendi verisini kullanıyor:

| Koşul | Sahip |
| --- | --- |
| `missClass = wrong-intent` veya `intent = unknown` | **RCE-014 intent model / RCE-015 query plan** |
| `stale` | RCE-026 freshness SLO |
| `source-needed` | RCE-010 extraction coverage / RCE-016 ranking |
| Diğer `wrong` | RCE-008 analyzer semantic correctness / RCE-007 confidence |

İki test bu ayrımı sabitliyor: sınıflandırılmamış soruda `wrong` → intent modeli; sınıflandırılmış soruda `wrong` → analyzer.

## 5. Backlog çıktısı

Canlı pilotta, telemetrinin kendi bulduğu boşluk için:

```jsonc
{
  "queryHash": "873e02a5d079b0ffe72500b380d4d058",
  "signal": "wrong", "state": "new", "reports": 1,
  "note": "verify olarak sınıflanmalıydı, unknown döndü",
  "snapshotSha": "6d5978b3b82ea1734868a4b2ccf870f40e389d14",
  "retrieval": {
    "intent": "unknown", "packKind": "unknown", "missClass": "missing-evidence",
    "resultCount": 5, "fallback": "targeted-source",
    "queryShape": { "words": 5, "lengthBucket": "s", "turkish": true, ... }
  },
  "suggestedOwner": "RCE-014 intent model / RCE-015 query plan",
  "draftCase": {
    "id": "RCE-FB-873e02a5", "job": "lookup", "strict": true,
    "policy": "memory-sufficient",
    "questionMissing": "MEMORY_TELEMETRY_QUERY_TEXT was off; supply the question during triage",
    "expectedEvidence": [], "baselineReadSet": [],
    "plan": [{ "tool": "memory_context", "args": {} }],
    "openedBy": "feedback:wrong"
  }
}
```

Taslak vaka bilerek **eksik** bırakılır: `expectedEvidence` ve `baselineReadSet` insan tarafından doldurulmalıdır. Motorun kendi başarısızlığı hakkında beklenen kanıtı kendisinin üretmesi, ölçümü geçersiz kılardı.

`questionMissing` alanı da bilinçli: telemetri varsayılan olarak soru metnini saklamaz (RCE-024), dolayısıyla triyaj sırasında soru elle girilmelidir. Gizlilik varsayılanı, kolaylık için gevşetilmedi.

## 6. Backlog durumları

`new → triaged → case-created | dismissed`

`case-created` durumu, ürettiği evaluation vakasının kimliği olmadan **yazılamaz** (`updateState` hata fırlatır). Bu, "bakıyoruz" ile "test yazdık" arasındaki farkı şemada zorunlu kılar.

`summary` çıktısı `actionableRate` verir: raporların ne kadarının motor değişikliği talep ettiği, ne kadarının çalıştığını onayladığı.

## 7. Bağımlılıklar

- **RCE-024** — `query_hash` eşleştirmesi ve `telemetryEventId` buradan gelir.
- **RCE-002** — taslak vakalar `config/context-engine-eval.json` şemasına uyar.
- **RCE-014/015, RCE-008, RCE-010/016, RCE-026** — sahip yönlendirmesinin hedefleri.
- **RCE-027** — `note` alanı serbest metindir ve kullanıcı tarafından yazılır; veri yönetişimi politikası bu alanı kapsamalıdır.
