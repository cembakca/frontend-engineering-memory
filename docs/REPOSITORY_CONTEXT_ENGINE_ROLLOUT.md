# RCE-029 — Kontrollü çoklu-repository rollout

**Tarih:** 31 Ağustos 2026  
**Politika:** [`config/rollout-gates.json`](../config/rollout-gates.json) → `multiRepository`  
**Uygulama:** [`src/rollout/rollout-plan.ts`](../src/rollout/rollout-plan.ts) — `pnpm memory rollout-status`  
**Test:** [`test/rollout-plan.test.ts`](../test/rollout-plan.test.ts) — 6 vaka

## 1. Merkez kural: kapı geriye de bakar

Rollout kapıları genellikle yalnız ileriye bakar — "yeni aday hazır mı?". Bu kontrolcü **önce geriye bakar**: hâlihazırda onboard edilmiş her repository sağlık tabanının üstünde mi?

Gerekçe ölçülmüş: RCE-004 context ekonomisinin doğruluğun türevi olduğunu gösterdi. Bozulan bir motora repository eklemek bozulmayı çoğaltır. Bir test bunu doğrudan sabitliyor — kapı açık olsa bile, mevcut bir repository geriler gerilemez rollout `hold` olur, ve **sağlıklı olan diğer repository başkasının gerilemesiyle suçlanmaz.**

## 2. Dalgalar

| Dalga | Boyut | Giriş koşulu | Soak |
| --- | ---: | --- | ---: |
| `pilot` | 1 | RCE-001 sözleşmesi pilotta karşılandı | 0 gün |
| `diversity` | 2 | İkinci pilot kapısı açık; aday farklı router/mimari | 7 gün |
| `squad` | 4 | Her iki pilot da soak boyunca sağlıklı; işletim maliyeti bütçede | 14 gün |
| `division` | 8 | Hiçbir repository sağlık tabanının altında değil; repo başına maliyet artmıyor | 14 gün |
| `fleet` | 16 | Önceki dalgada kararlı durum | 30 gün |

Boyutlar ikiye katlanıyor; her dalga bir öncekinin soak süresini tamamlamasını şart koşuyor.

## 3. Sağlık tabanı

| Ölçüt | Eşik |
| --- | --- |
| Freshness durumu | `fresh` veya `tree-dirty` (RCE-026) |
| Güvenlik invariant hatası | 0 (RCE-027) |
| `duplicationRatio` | ≤ 0,05 (RCE-005) |
| `evidenceCoverage` | ≥ 0,95 |

`unknown` freshness taban altıdır. Testlerde bu ilk başta engel oldu ve fixture'lar gerçek Git deposuna çevrildi — **ölçülemeyen durumun geçmiş sayılmaması** bu maddede de korunuyor.

## 4. İşletim maliyeti ölçülür, tahmin edilmez

| Ölçüt | Kaynak | Bütçe |
| --- | --- | ---: |
| Repo başına veritabanı boyutu | diskten `stat` | ≤ 50 MB |
| Retrieval p95 latency | RCE-024 telemetrisi | ≤ 5.000 ms |

Politikadaki not bilinçli: *repo başına maliyet registry büyürken yükselmemelidir; yükselen bir eğim tasarımın ölçeklenmediğini gösterir ve dalga tutulur.*

## 5. Bugünkü durum

```text
decision:     hold
currentCount: 1     currentWave: pilot     nextWave: diversity
operatingCost: 5.500.928 bayt (repo başına aynı), p95 3.097 ms — bütçede
repositories:
  hangikredi.aboutus.fe.next  healthy=false  tree-dirty  duplication 0.3886  evidence 1.0
blockers:
  - acceptance gate is blocked: 6 blocker(s)
  - hangikredi.aboutus.fe.next below the health floor: duplication 0.3886 over 0.05
```

İki bağımsız neden: RCE-028 kapısı kapalı **ve** pilotun kendisi taban altında. `duplicationRatio` 0,3886 → RCE-005 normalizasyonu henüz uygulanmadı; tasarım hazır, migration yapılmadı.

İşletim maliyeti tarafı sağlıklı: 5,5 MB ve p95 3 saniye, ikisi de bütçede. Yani darboğaz maliyet değil, **doğruluk**.

## 6. Testlerin kanıtladığı

| Test | Kanıt |
| --- | --- |
| Kapı kapalıyken tutar | Repository'ler ne olursa olsun |
| Geri gitmiş repository tutar | Kapı **açıkken** bile; sağlıklı olan suçlanmaz |
| Her şey yolundayken ilerler | `advance`, blocker listesi boş — kontrolcü sabit `hold` döndürmüyor |
| Dalga yerleşimi | 4 repository → `squad`, sonraki `division` |
| Registry dışı repository tutar | RCE-027'nin sınır kuralıyla aynı |
| Maliyet ölçülür | Veritabanı boyutu diskten okunuyor |

## 7. Bağımlılıklar

- **RCE-028** — kapı; `open` dönmeden hiçbir dalga ilerlemez.
- **RCE-026 / RCE-027 / RCE-005** — sağlık tabanının üç kaynağı.
- **RCE-024** — p95 latency ölçümü.
- **RCE-004** — "ekonomi doğruluğun türevidir" ilkesi, geriye bakma kuralının gerekçesi.
