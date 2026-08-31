# RCE-026 — Freshness SLO

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/retrieval/freshness.ts`](../src/retrieval/freshness.ts)  
**Hedefler:** [`config/freshness-slo.json`](../config/freshness-slo.json)  
**Test:** [`test/freshness.test.ts`](../test/freshness.test.ts) — 7 vaka  
**CLI:** `pnpm memory freshness [repository]`

## 1. Ayrılan iki soru

Bu maddenin çözdüğü asıl şey iki kavramın ayrılmasıdır:

| Soru | Ölçen |
| --- | --- |
| **Snapshot freshness** — indeks güncel commit'i mi anlatıyor? | `indexedSha` vs `headSha`, `driftCommits` |
| **Tree accuracy** — güncel commit diskteki dosyaları mı anlatıyor? | `workingTreeDirty`, `dirtyFileCount` |

RCE-N03 tam olarak burada başarısız olmuştu: motor birinci soruyu cevaplayıp ikincisi hakkında **sessiz kalıyordu**. `memory_get_repository` yalnız `lastIndexedSha` veriyordu ve agent bundan "güncel" sonucunu çıkarabiliyordu.

**`indexedSha == headSha` "güncel" demek değildir.**

## 2. Durum modeli

| State | Koşul | Cevaba zorunlu cümle |
| --- | --- | --- |
| `fresh` | SHA eşit, tree temiz | Facts describe the current commit |
| `tree-dirty` | SHA eşit, tree kirli | Facts describe the last commit, not the files on disk — verify against source |
| `behind` | HEAD'de indekslenmemiş commit var | Re-sync before treating these facts as current |
| `diverged` | İndekslenen commit HEAD'in atası değil | Branch rewritten — re-index before use |
| `never-indexed` | Hiç indekslenmemiş | No facts available; read the source |
| `unknown` | Repository erişilemiyor | Treat the facts as unverified |

Pilotun bugünkü durumu:

```json
{
  "state": "tree-dirty",
  "indexedSha": "6d5978b3…", "headSha": "6d5978b3…",
  "driftCommits": 0, "workingTreeDirty": true, "dirtyFileCount": 1,
  "mergeToIndexedLagSeconds": 30604,
  "slo": { "lag": "warn", "drift": "met", "overall": "warn" },
  "answerGuidance": "Snapshot matches HEAD, but 1 file(s) are uncommitted. Facts describe the last commit, not the files on disk — verify against source before acting on them."
}
```

## 3. SLO hedefleri

| Metrik | Hedef | Uyarı | İhlal | Gerekçe |
| --- | ---: | ---: | ---: | --- |
| `mergeToIndexedLagSeconds` | 900 | >900 | ≥86.400 | Sync merge sonrası CI ile tetiklenir. On beş dakika, cevabı bir inceleme döngüsü içinde tutar; bir gün eski indeks başka bir repository'dir. |
| `reconciliationDriftCommits` | 0 | ≥1 | ≥10 | Herhangi bir drift, cevabın kimsenin üzerinde çalışmadığı bir snapshot'ı anlattığı anlamına gelir. Merge ile sync arasında bir commit tolere edilebilir; on tanesi pipeline'ın bozuk olduğunu gösterir. |

Gecikme **commit zamanından indeksleme bittiği ana kadar** ölçülür, sync tetiklendiği andan değil — yavaş bir tetikleyici de yavaş bir cevaptır.

## 4. Stale cevap davranışı: bir sözleşme, bir tercih değil

Üçüncü hedef sayısal değil davranışsal:

> `staleAnswerBehaviour: every-pack-declares-freshness`
>
> Motor drift'i engelleyemez, ama drift etmiş veya tree'si kirli bir snapshot'ı **asla güncelmiş gibi sunamaz.** Freshness durumunu atlayan bir pack, veri taze olsa bile sözleşme ihlalidir.

Bu yüzden `memory_context` artık her pack'e ekliyor:

```jsonc
"freshness": {
  "state": "tree-dirty",
  "indexedSha": "…", "headSha": "…",
  "driftCommits": 0, "workingTreeDirty": true,
  "guidance": "Snapshot matches HEAD, but 1 file(s) are uncommitted. …"
}
```

`guidance` boş bırakılamaz; `fresh` durumunda bile bir cümle taşır. Bir test bu alanların varlığını sabitliyor.

## 5. Bütçe entegrasyonu ve yol boyunca çıkan iki hata

Freshness bloğu önce pack derlendikten **sonra** ekleniyordu. Bu, RCE-017'nin bütçe sözleşmesini bozdu: pack ilan ettiği `maxChars`'ı aşıyordu (1379 > 1200) ve MCP testi bunu yakaladı.

İlk düzeltme denemesi bütçe tabanını 1000'den 400'e indirmekti; ikinci bir test bunun **kasıtlı ve sözleşmeli** bir taban olduğunu gösterdi. Doğru çözüm, freshness'i pack'in bir parçası olarak derleyiciye geçirmekti: artık `CommonInput` ve `BasePack` içinde, diğer içerik gibi bütçeleniyor.

Bu, ikinci ve daha ciddi bir hatayı ortaya çıkardı. Zarf bütçeye dahil olunca küçük bir bütçede tek fact dışarı düşüyor ve pack şunu diyordu:

> "No match; report the miss and use targeted fallback."

**Bu yalan.** Eşleşme vardı, sığmadı. Agent'ı olmayan bir retrieval miss'i raporlamaya yönlendiriyordu. Ayrım artık yapılıyor:

```jsonc
{ "items": [], "budgetExceeded": true,
  "guidance": "Matches exist but exceed maxChars; raise the budget rather than reporting a miss.",
  "answerContract": { "uncertainty": { "reasons": ["matching memory was found but did not fit maxChars=1000; raise the budget"] } } }
```

Blok ayrıca kompaktlaştırıldı: null alanlar düşürülüyor (`headSha` yalnız `indexedSha`'dan farklıysa yazılıyor), çünkü ölçülemeyen bir değer bilgi taşımaz ve bu blok fact'lerle aynı bütçe için yarışır.

## 6. Önbellek kararı

Freshness bir `git` çağrısı gerektirdiği için 15 saniyelik TTL ile önbelleklenir (`MEMORY_FRESHNESS_TTL_MS`). TTL kısa tutuldu ve **SHA'ya göre önbelleklenmedi**: drift, snapshot değişmeden oluşur. SHA anahtarlı bir önbellek, tam olarak bu kontrolün yakalamak için var olduğu durumu gizlerdi.

## 7. Ölçülemeyen durumlar sessizce "taze" sayılmaz

Repository yolu erişilemezse veya git deposu değilse durum `unknown` olur ve `warnings` doldurulur; SLO `unknown` döner. Hiçbir kod yolu, ölçemediği bir şeyi `met` olarak raporlamaz.

## 8. Bağımlılıklar

- **RCE-002 / RCE-N03** — bu maddenin doğrudan kapattığı vaka.
- **RCE-007** — `guidance` cümleleri confidence sözleşmesinin cevap dili kuralıyla aynı mantıkta: ölçülmemiş bir güven iddia edilmez.
- **RCE-025** — `stale` feedback sinyalinin sahibi bu maddedir; artık raporlanan `stale` bir SLO durumuyla karşılaştırılabilir.
- **RCE-021** — `atSha` ile bilinçli olarak geçmişe bakmak stale değildir; freshness yalnız *istenmeyen* sapmayı ölçer.
