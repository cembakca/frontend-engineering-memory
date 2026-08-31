# Bütüncül uygulama geçişi — ölçüm sonuçları

**Tarih:** 31 Ağustos 2026  
**Kapsam:** RCE-005 (kanonikleştirme), RCE-006 (kabul politikası), RCE-008-B/C/D/F/G/H (analyzer semantiği), tohum çözümü ve iki bayat ölçüm  
**Doğrulama:** pilotun temiz bir klonu geçici bir veritabanına yeniden indekslendi; kullanıcının çalışma ağacına dokunulmadı

## 1. Sonuç tablosu

| Metrik | Geçiş öncesi | Geçiş sonrası | Hedef |
| --- | ---: | ---: | ---: |
| Mean evidence recall | 0,5436 | **0,9115** | ≥ 0,90 ✅ |
| Temiz vaka (birincil miss yok) | 4/15 | **11/15** | ≥ 12/15 |
| Etkin medyan tasarruf | **−883 tok** | **+755 tok** | > 0 ✅ |
| Aktif memory | 175 | **85** | ~74 |
| `duplicationRatio` | 0,3886 | **0** | ≤ 0,05 ✅ |
| `symbolCoverage` | 0,3086 | **0,5882** | ≥ 0,60 |
| Bloke eden semantic gap | 2 | **0** | 0 ✅ |
| Sabit oturum maliyeti | 1.998 tok | **740 tok** | ≤ 1.500 ✅ |
| Test | 128 | **134** | — |

Kapı: **4 kontrol geçiyor, 3 kalıyor.**

## 2. En büyük tek kazanç ölçüm hatasıydı, kod değil

Evaluation suite'i beş MCP tool'u çağırıyordu: `memory_search`, `memory_get_route`, `memory_dependencies`, `memory_list_routes`, `memory_get_repository`. RCE-019 agent yüzeyini üç tool'a indirmişti ve **bu beşinin hiçbiri artık sunulmuyordu.**

Yani kapının, ekonomi defterinin ve miss taksonomisinin okuduğu her sayı, hiçbir agent'ın gidemeyeceği bir yolu ölçüyordu. Suite gerçek yüzeye çevrildiğinde tek başına:

```text
recall 0,5615 -> 0,7705
```

Ders: **ölçüm altyapısı da ürün yüzeyi kadar bakım ister.** Bir tool kaldırıldığında onu ölçen suite sessizce yanlış bir dünyayı ölçmeye devam eder.

Aynı sınıftan iki hata daha bulundu ve düzeltildi:

- `agent-policy` kuralı "pack item döndürdü mü" diye bakıyordu. Oysa RCE-018'den sonra pack destekleyici fact döndürüp yine de doğru şekilde çekince koyabiliyor. Kural "yetersizliğini **ilan etti mi**" olarak değiştirildi; D07 ve N07 böylece doğru sınıflandı.
- `economy.engineLoses` oranı `abstain` vakalarını da sayıyordu. Kaynağın cevaplayamadığı bir soru için okunacak kaynak yoktur; "motor source'dan pahalı" karşılaştırması orada tanımsızdır. Bu vakalar ayrı raporlanıyor.

## 3. Analyzer semantiği — RCE-008

Üç kural uygulandı:

1. **Kontrol akışı rendering'den önce gelir.** `redirect()` / `notFound()` artık `controlFlow` alanında, hedefi ve koşullu olup olmadığıyla birlikte kaydediliyor. Gövdesi koşulsuz `redirect()` olan bir sayfa hiç render etmez.
2. **Sayfanın kendi segment direktifi otoriterdir.** `export const dynamic` / `revalidate` artık `segmentConfig` alanında saklanıyor ve erişilebilir bir yardımcı modülün sinyali onu ezemiyor.
3. **Erişilebilirlik katkı değildir.** Koşulsuz redirect eden veya kendi direktifini beyan eden bir route, behaviour dosyalarından rendering mirası almıyor.

Ayrıca `renderingBasis` alanı eklendi (`observed` / `directive` / `inherited` / `default`) — RCE-007'nin "yokluktan türetme kesin sunulamaz" kuralının kayıttaki karşılığı.

Sekiz characterization vakasının yedisi kapandı. Açık kalan tek vaka `RCE-008-E` (rewrite delegation) ve **bloke etmiyor**: envanter eksik ama söylediği hiçbir şey yanlış değil.

## 4. Kanonikleştirme — RCE-005'in özü

Tam entity/occurrence şeması yerine, aynı hedefe memory seviyesinde ulaşıldı: aynı `(tip, konu)` çiftine sahip occurrence'lar tek bir fact'te birleşiyor, diğer dosyalar evidence oluyor.

`GATEWAY_URL` artık **tek** kayıt:

```text
Configuration key GATEWAY_URL is read in next.config.ts, src/lib/gateway.ts;
declared in .env.corlu.production, .env.production, .env.staging, .env.test.
```

Bu cümle daha önce hiçbir yerde yoktu — 84 config kaydı 19'a inerken bilgi kaybı olmadı, **bilgi kazanıldı**.

Yalnız konusu repository çapında bir varlık olan tipler birleştiriliyor (`configuration`, `dependency`, `shared_package`). `cache`, `seo`, `api_dependency` için konu dosyanın kendisidir; onları birleştirmek bir iddia uydurmak olurdu.

### Bedavaya gelen sinyal

Kanonik model, RCE-005'in öngördüğü ölü konfigürasyon sinyalini üretti. Pilotta üç anahtar dört ortamın hepsinde tanımlı ama **kodda hiç okunmuyor**: `NEXT_PUBLIC_APP_MODE`, `NEXT_PUBLIC_USE_MONITORING`, `GATEWAY_API_URL`. `quality` raporunda `unreadConfigKeys` olarak görünüyor.

## 5. Kabul politikası — RCE-006

Extraction'da reddedilenler: `business_capability` (yoldan türetilebilir), `design_system` (dependencies satırının tekrarı), `next.config.ts` generic build satırı, ve `performance_observation`'ın `react` import kuralı — 11 kayıttan 10'u bu false positive'di, artık yalnız `next/dynamic` sinyal sayılıyor.

`dependency` memory'leri **korundu**: RCE-006 onları "model-redundant" işaretlemişti, ama `search.ts`'te dependencies tablosu için bir kanal yok, dolayısıyla silmek paket aramasını tamamen kaybettirirdi. Yapısal satırın indekslenmesi RCE-016'nın işidir; o gelene kadar silmek regresyon olurdu.

## 6. Tohum çözümü

Flow ve impact traversal'ının başlangıç düğümü üç şekilde yanlış seçiliyordu:

- Kelime örtüşmesi `ContactInfoBand`'i `ContactForm` kadar iyi eşleştiriyordu
- Giden davranışsal kenarı olmayan bir **dosya** seçilebiliyordu → boş pack
- `exports` kenarı dosyaya sahte bir out-degree veriyordu

Düzeltildi: aday puanlaması artık adayın **ulaştığı** düğümlere de bakıyor, `exports` tohum indeksinden çıkarıldı, ve eşitlikte daha küçük alt ağaç kazanıyor (sayfa yerine içindeki handler).

Denenip **geri alınan** bir varyant: puanı eşleşen düğüm sayısı yerine kapsanan farklı terim sayısıyla vermek. Ölçüm kötüleşti (recall 0,9115 → 0,85, captcha akışı bozuldu), değişiklik geri alındı ve gerekçesi koda yorum olarak yazıldı.

## 7. Kalan üç engel — tek kök neden

```text
retrieval.strict     6/7           needs >= 1
retrieval.clean      11/15 (0,73)  needs >= 0,80
economy.engineLoses  2/14 (0,14)   needs <= 0,10
```

Dört vaka (`F01`, `I05`, `P03`, `D01`) aynı boşluğa çıkıyor: **captcha modülü ve insertcomment handler'ı için odaklı fact yok.** `captcha-headers.ts`, `captcha-registry.ts`, `get-captcha-token.ts` graph'ta kenar olarak var ama fact olarak yok; `readCaptchaFromBody` null döndüğünde `400 Captcha failed` üretildiğini söyleyen bir kayıt hiç mevcut değil.

Bu, RCE-003'ün ölçtüğü asıl boşluğun kalan yarısıdır: analyzer fetch çağrısı, env anahtarı, cache direktifi ve import için fact üretiyor; **modül sözleşmesi, export davranışı ve hata cevabı için hiçbir fact tipi yok.** Kapatacak madde RCE-013'ün hata/verification fact tipleridir.

## 8. Canlı veritabanı bu durumda değil

Bütün ölçümler pilotun **temiz bir klonundan** alındı. Canlı `data/engineering-memory.sqlite` hâlâ eski indeksi taşıyor, çünkü pilot repository'nin çalışma ağacı kirli (`M AGENTS.md`) ve indexer bunu doğru şekilde reddediyor.

Güncellemek için:

```bash
cd "../hangikredi.aboutus.fe.next" && git stash      # veya commit
cd "../frontend-engineering-memory" && pnpm memory full hangikredi.aboutus.fe.next
```
