# RCE-024 — Retrieval telemetry

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/telemetry/retrieval-telemetry.ts`](../src/telemetry/retrieval-telemetry.ts)  
**Test:** [`test/telemetry.test.ts`](../test/telemetry.test.ts) — 7 vaka  
**CLI:** `pnpm memory telemetry [repository] [--recent=20] [--limit=200] [--prune]`

## 1. Gizlilik modeli: whitelist, blacklist değil

Kaydedici kapalı ve tipli bir event kabul eder; yalnız şemada tanımlı alanları yazar. Bu bilinçli bir seçim: bir redaction blacklist'i, ileride context pack'e eklenen yeni bir alanı er ya da geç sızdırır. Whitelist sızdıramaz.

**Asla kaydedilmez:** fact içeriği, evidence alıntısı, kaynak kod, konfigürasyon **değerleri**, `.env` içeriği.

**Kaydedilir:** entity adları (`GATEWAY_URL`, `/api/pages/aboutus/insertcomment`, dosya yolları), sayımlar, süreler. Gerekçe: bunlar zaten indekste duran repository tanımlayıcılarıdır. **Anahtar adı sır değildir, anahtar değeri sırdır** — ve değerler bu sistemde hiçbir yerde saklanmaz.

**Soru metni varsayılan olarak saklanmaz.** Bunun yerine:

| Alan | İçerik |
| --- | --- |
| `query_hash` | Normalize edilmiş sorunun sha256'sının ilk 32 karakteri — tekrar eden soruları gruplamak için |
| `query_shape_json` | `{words, lengthBucket, turkish, hasRoutePath, hasFilePath, hasConfigKey}` |
| `query_text` | **Yalnız** `MEMORY_TELEMETRY_QUERY_TEXT=1` iken |

Canlı pilot verisinde doğrulandı:

```text
Gizlilik kontrolü: tabloda içerik var mı?
  gatewayapi     yok
  http://        yok
  revalidate     yok
  export const   yok
  process.env    yok
```

Bir test bunu regresyon olarak sabitliyor: fixture'a `"GATEWAY_URL points at http://gatewayapi.gateways ..."` içerikli bir fact yazılır, gerçek bir retrieval çalıştırılır ve telemetri tablosunda bu içeriğin hiçbir parçasının bulunmadığı, ama `GATEWAY_URL` tanımlayıcısının `result_ids` içinde bulunduğu doğrulanır.

## 2. Ölçülenler

`retrieval_events` tablosu TODO'nun istediği yedi kalemi karşılıyor:

| İstenen | Alan |
| --- | --- |
| Tool seçimi | `tool` |
| Query planı | `intent`, `channels_json`, `second_round` |
| Sonuç ID'leri | `result_ids_json`, `result_count` |
| Payload karakter / token tahmini | `payload_chars`, `estimated_tokens` |
| Latency | `latency_ms` |
| Fallback | `fallback` (`none` / `targeted-source` / `abstain`) |
| Retrieval miss | `miss_class`, `gaps_json` |

Ek olarak `snapshot_sha` ve `pack_kind` saklanır.

### Intent, pack kind'dan ayrı kaydedilir

İlk uygulamada intent yoksa `pack.kind`'a düşülüyordu; bu, `implementation-plan` ile `verify` ayrımını yok ediyordu (ikisi de `implementation` pack'i üretir). Telemetri artık planı kendisi çalıştırıyor (saf string analizi, I/O yok):

```text
intent                pack_kind      channels
explain-flow          flow           exact-sql+graph-flow+fts+source-fallback
impact                impact         exact-sql+graph-impact+fts+source-fallback
debug                 debug          exact-sql+graph-flow+fts+vector+source-fallback
implementation-plan   implementation fts+graph-flow+verification-graph+vector+graph-impact+source-fallback
```

## 3. Miss sınıflandırması

RCE-003 taksonomisinin **yalnız motorun kendi başına ayırt edebildiği** sınıfları otomatik atanır; gerisi tahmin edilmek yerine `null` bırakılır:

| Koşul | Sınıf |
| --- | --- |
| Hata fırlatıldı | `engine-error` |
| Gap "seed could not be resolved" diyor | `wrong-intent` |
| Sonuç sayısı 0 | `missing-fact` |
| Targeted source fallback öneriliyor | `missing-evidence` |
| Diğer | `null` |

## 4. İşletim kuralları

- **Telemetri hiçbir koşulda cevabı bozamaz.** `record()` asla fırlatmaz; yazma başarısız olursa uyarı basılır ve retrieval normal döner. Bir test bunu tabloyu silip doğruluyor.
- **Girdi normalize edilir.** Kaydedici, çağıranın verdiği şekli `toStringArray` ile düzeltir. Bu gerçek bir hatayı yakaladı: `answerContract.uncertainty` bir dizi değil `{level, reasons}` objesi; normalizasyon olmasaydı olay tamamen kaybolurdu.
- **Sınırsız büyümez.** Her 100 kayıtta bir budama çalışır; `MEMORY_TELEMETRY_RETENTION` (varsayılan 5000) en yeni olayları tutar.
- **Kapatılabilir.** `MEMORY_TELEMETRY_ENABLED=0`.

## 5. İlk gerçek ölçüm — pilot, 6 soru

```text
events: 6
byIntent:     explain-flow 1, impact 1, debug 1, implementation-plan 1, unknown 2
byMissClass:  missing-evidence 5, none 1
byFallback:   targeted-source 5, none 1
missRate:     0.83
latencyMs:    p50 29, p95 3097
estimatedTokens: p50 2274, p95 2286
```

Üç şey hemen okunuyor:

1. **p95 latency 3097 ms** — flow sorusu semantic graph'ı ilk kez kuruyor. Sonraki sorular 19–32 ms. Snapshot cache'i çalışıyor ama ilk isabetin maliyeti görünür oldu.
2. **`missRate` 0,83** — altı sorunun beşinde motor targeted source fallback öneriyor. RCE-002'nin bulgusuyla tutarlı; artık her çağrıda otomatik ölçülüyor.
3. **Telemetri hemen bir intent boşluğu gösterdi:** *"Değişiklikten sonra hangi komutları çalıştırmalıyım?"* sorusu `unknown` sınıflandırıldı, oysa `verify` olmalıydı. Bu, RCE-014'ün sinyal sözlüğünde eksik bir kalıp; telemetrinin varlık nedeni tam olarak bunu kendiliğinden yüzeye çıkarmaktır. **RCE-025'in backlog'una girer.**

## 6. Bağımlılıklar

- **RCE-003** — miss sınıfları aynı taksonomiyi kullanır.
- **RCE-004** — `payload_chars` ve `estimated_tokens` ekonomi defterinin 2. kalemidir; cache ve toplam context hâlâ yalnız client'tan gelir ve motor bunları tahmin etmez.
- **RCE-025** — feedback loop bu tablodaki `query_hash` üzerinden olayı kullanıcı sinyaliyle eşleştirir.
- **RCE-027** — `query_text` opt-in'i ve retention burada tanımlandı; veri yönetişimi politikası bunları devralır.
