# RCE-028 — İkinci pilot kabul kapısı

**Tarih:** 31 Ağustos 2026  
**Eşikler:** [`config/rollout-gates.json`](../config/rollout-gates.json)  
**Uygulama:** [`src/rollout/pilot-gate.ts`](../src/rollout/pilot-gate.ts) — `pnpm memory pilot-gate [--candidate=<repo>]`  
**Test:** [`test/pilot-gate.test.ts`](../test/pilot-gate.test.ts) — 7 vaka

## 1. Kapı bir toplantı değil, bir komut

Bu madde bir karar toplantısı tanımlamıyor. Ölçülmüş koşuları okuyup `open` / `blocked` / `insufficient-evidence` döndüren, ihlalde çıkış kodu 1 veren bir komut üretiyor. Kapı fikir kabul etmez; `context-eval`, `context-economy`, `security-audit` çıktılarını ve semantic gap defterini okur.

## 2. Bugünkü sonuç: **blocked**

```text
decision: blocked
blockers:
  retrieval.recall: 0.5436 (needs >= 0.9)
  retrieval.strict: 3/7 (needs >= 1)
  retrieval.clean: 4/15 (0.27) (needs >= 0.8)
  economy.effectiveSaving: -883 tokens (needs >= 1)
  economy.engineLoses: 3/15 (0.20) (needs <= 0.1)
  semantics.blockingGaps: 2 open (RCE-008-B, RCE-008-C) (needs <= 0)
governance.securityAudit: pass (0 failing, 0 skipped)
```

Altı engelden beşi RCE-001 ve RCE-004 sözleşmelerinin doğrudan ihlali. Tek geçen kontrol yönetişim.

Bu, kapının çalıştığının kanıtıdır: **ikinci repository bugün eklenemez.** Eklenirse ölçülmüş şekilde yanlış cevap veren ve token kaybettiren bir motor çoğaltılmış olur.

## 3. Kontroller

| ID | Gereksinim | Eşik | Kaynak |
| --- | --- | --- | --- |
| `retrieval.recall` | Gerekli evidence recall'ü | ≥ 0,90 | context-eval koşusu |
| `retrieval.strict` | Strict vakaların miss'siz cevaplanması | %100 | context-eval, `strict` vakalar |
| `retrieval.clean` | Birincil miss sınıfı olmayan vaka oranı | ≥ 0,80 | context-eval, `primaryMissClass` |
| `economy.effectiveSaving` | Başarısız pack'in source okumasını da ödettiği senaryoda medyan tasarruf | > 0 | context-economy |
| `economy.engineLoses` | Motorun source okumaktan pahalıya geldiği vaka oranı | ≤ %10 | context-economy |
| `semantics.blockingGaps` | Yanlış olduğu bilinen analyzer semantiği | 0 | `src/analyzers/semantic-gaps.ts` |
| `governance.securityAudit` | Veri yönetişimi invariant'ları | 0 hata | security-audit |
| `candidate.registered` | Aday registry'de mi | zorunlu | registry |
| `candidate.diversity` | Farklı router/mimari | bildirilir | — |

## 4. Semantic gap defteri tek kaynağa taşındı

RCE-008'in açık boşluk listesi test dosyasının içindeydi. Kapı da onu okumak zorunda olduğu için `src/analyzers/semantic-gaps.ts`'e çıkarıldı; characterization suite ve kapı artık **aynı listeyi** kullanıyor.

Ayrıca `BLOCKING_SEMANTIC_GAPS` tanımlandı: sekiz açık boşluğun ikisi (`RCE-008-B` `/` redirect regresyonu, `RCE-008-C` `force-static` ezilmesi) ikinci repository'yi bloke eder. Gerekçe basit — **yanlış bir fact seyahat eder.** Diğer altısı eksikliktir, yanlışlık değil.

## 5. `unknown` asla `pass` değildir

Koşu dosyası yoksa ilgili kontrol `unknown` olur ve karar `insufficient-evidence`'a düşer; `open` olmaz. Bir test bunu sabitliyor. Aynı ilke aday çeşitliliğinde de geçerli: bir repository indekslenmeden router tipi bilinemez, dolayısıyla `candidate.diversity` `unknown` döner ve neyin farklı olması gerektiğini **yazar** — geçmiş gibi davranmaz.

## 6. Aday seçim kuralı

> `architecture-diversity-only` — İkinci pilot yalnız ilk pilotun sınamadığı bir router veya mimariyle gerekçelendirilir. Aynı şekle sahip ikinci bir repository maliyet ekler, yeni kanıt eklemez.

Pilot `app` router kullanıyor. İkinci pilot için anlamlı adaylar: Pages Router, hybrid router, veya farklı bir veri katmanı (ör. TanStack Query ağırlıklı bir uygulama) — bunlar RCE-010'un çıkarıcısını ve RCE-008'in sınıflandırıcısını gerçekten farklı bir yüzeyde sınar.

## 7. Testlerin kanıtladığı

Kapının bloke edebildiği gösterildi: düşük recall, kaçırılmış strict vaka, negatif etkin tasarruf, kayıp vaka oranı, registry'de olmayan aday ve eksik koşu — her biri ayrı bir testle. Birinci test ise tersini gösteriyor: bütün ölçülen eşikler karşılandığında **yalnız semantic gap engeli kalıyor**, yani kapı ölçümlere gerçekten tepki veriyor, sabit `blocked` döndürmüyor.

## 8. Bağımlılıklar

- **RCE-001** — eşiklerin kaynağı.
- **RCE-002 / RCE-004** — kapının okuduğu koşular.
- **RCE-008** — bloke eden semantic gap'ler.
- **RCE-027** — yönetişim kontrolü.
- **RCE-029** — çoklu repository rollout'u bu kapının `open` dönmesini şart koşar.
