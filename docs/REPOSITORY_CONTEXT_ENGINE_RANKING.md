# RCE-016 — Canonical dedupe ve ranking

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/retrieval/ranking.ts`](../src/retrieval/ranking.ts)  
**Search entegrasyonu:** [`src/retrieval/search.ts`](../src/retrieval/search.ts)  
**Test:** [`test/ranking.test.ts`](../test/ranking.test.ts) — 6 vaka  
**Durum:** kanonik entity dedupe ve feature-based ranking aktif

## 1. Ölçülen problem

Pilot snapshot'ında 175 aktif memory var. Configuration dağılımı:

| Metrik | Sonuç |
| --- | ---: |
| Configuration memory | 84 |
| Benzersiz config subject | 19 |
| `HOST` occurrence | 7 |
| `GATEWAY_URL` configuration occurrence | 6 |
| `config:GATEWAY_URL` dependency kaydı | 2 |
| Dolu `quality_score` | 0 |

Eski hybrid search aynı memory ID'si FTS/vector/SQL'den gelince kanal puanlarını topluyor, farklı ID'lerdeki aynı entity'yi ise ayrı sonuç sayıyordu. Çok kopyalanan occurrence hem sonuç kotasını tüketiyor hem çok kanallı olduğu için davranışsal olarak daha güçlüymüş gibi yükselebiliyordu.

## 2. Kanonik dedupe

Identity key occurrence ve kanal içermez:

```text
<repository>:config:<KEY>
<repository>:route:<HTTP path>
<repository>:<memory type>:<normalized subject>
```

Özel olarak:

```text
configuration / GATEWAY_URL
dependency    / config:GATEWAY_URL
              ↓
hangikredi.aboutus.fe.next:config:GATEWAY_URL
```

Bir grupta en yüksek feature skoruna sahip kayıt temsilci olur. Bütün kanal provenance'ı, source dosyaları ve diğer memory ID'leri `channels`, `sourceFiles`, `duplicateIds` alanlarında birleşir. Context builder evidence'ı yalnız temsilci ID'den değil, bütün duplicate ID'lerden toplar.

Source-line suffix'i (`file.ts:17`) identity'nin parçası değildir; bu bir occurrence konumudur. Farklı fact tipleri genel durumda korunur, yalnız açıkça aynı entity kind'ına çözülen config/dependency ve route kayıtları birleşir.

## 3. Ranking özellikleri

Kanal puanları toplanmaz. Normalize skor:

| Özellik | Ağırlık | Kaynak |
| --- | ---: | --- |
| Task fit | %25 | RCE-014 intent, memory type, exact anchor, inferred-type boost |
| Relation coverage | %25 | Graph sonucu; tekil memory default olarak düşük coverage |
| Freshness | %20 | fact `commitSha` ile repository `lastIndexedSha` eşitliği |
| Evidence quality | %15 | quality score veya confidence + evidence + line location |
| Entity specificity | %10 | exact route/config/symbol/file identity |
| Channel relevance | %5 | Kanalların toplamı değil, yalnız en iyi kanal sırası |

Feature skorları `[0,1]` aralığındadır. Sonuçtaki `ranking.features`, sıralama kararının denetlenebilmesini sağlar.

## 4. Evidence quality fallback

Pilotun bütün `quality_score` alanları boş olduğu için ranking bu alan varmış gibi davranamaz. Fallback:

- `verified`/`observed`, `derived`, `inferred` sırasıyla azalan taban alır.
- En az bir evidence dosyası ve source line kaliteyi artırır.
- `.env*` dosyası yalnız config occurrence kanıtıdır; behavioral/quotable evidence olmadığı için 0,35 ceza alır.
- Açık `qualityScore` varsa fallback yerine doğrudan `[0,1]` aralığında kullanılır.

Bu politika `GATEWAY_URL` temsilcisinin ilk FTS hit'i olan `.env.production` yerine `next.config.ts` olmasını sağladı.

## 5. Freshness

Fact SHA repository'nin indexed SHA'sıyla eşitse freshness 1; farklıysa 0,2; taraflardan biri yoksa 0,5'tir. Böylece stale kayıt tamamen gizlenmez ama eşit task/evidence koşulunda güncel kayıt onu geçer. Working-tree doğruluğu ayrı snapshot politikasıdır; SHA eşitliği uncommitted değişikliği kapsamaz.

## 6. Task fit ve exact anchor

Intent başına tercih edilen memory tipleri vardır; ancak tercih tek başına kesin eşleşme değildir. Query planner'ın çıkardığı exact route/file/symbol/config anchor'ı en yüksek task fit'i alır.

Örneğin `GATEWAY_URL değişirse hangi route ve handler etkilenir?` için:

1. `config:GATEWAY_URL` exact anchor
2. İki ilgili route handler
3. İki ilgili fetch occurrence

Genel route kayıtları sırf sorguda “route” kelimesi geçti diye exact SQL envanterinden eklenmez. Route envanteri yalnız `lookup` intent'inde veya gerçek `/path` anchor'ında açılır.

## 7. Dedupe öncesi aday bütçesi

Ranking/dedupe retrieval'dan sonra yapılır. `limit=5` için yalnız 15 FTS satırı çekildiğinde sekiz `GATEWAY_URL` occurrence'ı havuzu tüketiyor, daha kaliteli source-code occurrence'ı ranker'a ulaşamıyordu.

FTS pre-rank havuzu bu yüzden `max(50, limit×6)`, üst sınır 200 olarak değiştirildi. Kullanıcı payload'ı büyümez; genişleme yalnız yerel aday havuzundadır ve çıktı yine requested limit ile kesilir.

## 8. Pilot sonucu

`GATEWAY_URL` entity grubu:

| Önce | Sonra |
| --- | --- |
| 6 configuration + 2 dependency result | 1 canonical result |
| İlk temsilci `.env.production` | Temsilci `next.config.ts` |
| Ayrı occurrence evidence'ları | 6 benzersiz source file |
| Kanal/ID tekrarları sonuç kotasını tüketiyor | 7 ID `duplicateIds` altında |

I02 tarzı impact sorgusunun top-5'i exact config entity, iki handler route ve iki fetch'ten oluşuyor.

## 9. Açık sınır

Ranking hangi kanonik entity ve relation'ın önce gelmesi gerektiğini çözer. Flow/impact/implementation/debug için nihai typed ve token-budgeted alan seçimi RCE-017 context-pack şemalarının işidir.
