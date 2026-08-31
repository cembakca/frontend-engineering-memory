# RCE-003 — Retrieval miss taksonomisi

**Tarih:** 31 Ağustos 2026  
**Girdi:** RCE-002 ilk 15 vaka koşusu (`eval-results/rce-002-run-1.json`)  
**Sınıflandırma:** `pnpm memory context-eval` içinde otomatik ve deterministik — [`src/retrieval/context-eval.ts`](../src/retrieval/context-eval.ts)

## 1. Neden ölçülen taksonomi

Bir başarısızlığı "ilgili fact bulunamadı" diye kaydetmek işe yaramaz. Düzeltmenin sahibi katman, ancak şu ayrım yapılırsa belirlenebilir:

- Fact **hiç çıkarılmadı** mı? → analyzer sorunu
- Fact **var ama sorgu onu eledi** mi? → query understanding sorunu
- Fact **var, elenmedi, ama pencereye girmedi** mi? → ranking sorunu
- Motor **yanlış bir şey iddia etti** mi? → fact quality sorunu
- Motor **cevaplanamaz soruya cevap verir gibi** mi davrandı? → answer contract sorunu

Bu ayrım fikir beyanı değil, sorgulanabilir veri. Harness her eksik evidence dosyası için store'a bakıp o dosya hakkında **focused fact** olup olmadığını kontrol eder, sorgunun ürettiği tip filtresini uygular ve sınıfı deterministik kuralla atar. Koşu tekrarlanabilir; düzeltme geldikçe sınıf dağılımı regresyon verisi olur.

**Focused fact tanımı:** evidence olarak **4 veya daha az** dosya gösteren memory. Gerekçesi bölüm 3'te.

## 2. Sınıf tanımları

| Sınıf | Tanım | Ölçülebilir sinyal | Sahip katman | Düzeltecek madde |
| --- | --- | --- | --- | --- |
| `unsupported-inference` | Pack, kaynağın yalanladığı bir şey iddia ediyor | `packForbidden` deseni pack içinde geçiyor | Analyzer / fact quality | RCE-007, RCE-008 |
| `wrong-intent` | Sorgu yanlış kanal veya yanlış tip seçti; doğru fact hiç değerlendirilmedi | Ölü tip filtresi, route misparse, veya focused tipler ∩ çıkarılan tipler = ∅ | Query understanding | RCE-014, RCE-015 |
| `missing-fact` | O dosya hakkında hiç focused fact yok | `focusedTypes` boş | Analyzer / extraction | RCE-008, RCE-013 |
| `ranking` | Focused fact var, filtreyi geçti, ama dönen pencereye girmedi | `focusedTypes` filtreyle kesişiyor, yine de payload'da yok | Ranking / dedupe | RCE-016 |
| `missing-relation` | Dosya yalnız geniş route closure'ı içinde anılıyor; yönlü, tipli kenar yok | `focusedTypes` boş **ve** `broadTypes` dolu | Graph | RCE-009, RCE-010, RCE-011 |
| `over-retrieval` | Pack, beklenmeyen ≥3 dosyaya atıf yapıyor | `citedButNotExpected` ≥ 3 | Kabul politikası / ranking | RCE-006, RCE-016 |
| `agent-policy` | Cevaplanamaz soruya abstention sinyali olmadan fact döndürülüyor | Policy `abstain`/`report-gap` iken pack ≥1 item döndürdü | Answer contract / MCP yüzeyi | RCE-018, RCE-019 |
| `stale` | Fact eski SHA'yı temsil ediyor | indexed SHA ≠ hedef SHA | Sync / freshness | RCE-026 |

### Kural sırası

Yukarı akıştaki neden her zaman kazanır — hiç değerlendirilmemiş bir fact ranking'e yazılamaz:

1. `packForbidden` eşleşti mi → **`unsupported-inference`**
2. Pack boş mu → ölü tip filtresi varsa **`wrong-intent`**, yoksa **`missing-fact`**
3. Policy `abstain`/`report-gap` iken item döndü mü → **`agent-policy`**
4. Eksik evidence yok mu → **temiz** (uyarı varsa yalnız uyarı olarak kaydedilir)
5. Route misparse var mı → **`wrong-intent`**
6. Aksi halde dosya başına sınıflandır, çoğunluğu al; eşitlikte şiddet sırası: `unsupported-inference` > `wrong-intent` > `agent-policy` > `missing-fact` > `ranking`

4. adım kasıtlı: RCE-F06'da route regex'i `/component` üretiyor ama vaka doğru cevaplanıyor. Uyarı kaydedilir, miss sayılmaz. Doğru cevabı başarısızlık olarak raporlayan bir taksonomi öncelik sırasını bozar.

## 3. Yapısal kök neden — evidence modelinin iki uçlu olması

Bu, 15 vakanın altındaki tek en derin bulgu ve doğrudan ölçüldü:

| Memory tipi | Memory | Evidence satırı | Memory başına dosya |
| --- | ---: | ---: | ---: |
| `rendering` (route memory) | 10 | 203 | **20,3** |
| Diğer 12 tipin tamamı | 165 | 165 | **1,0** |

Ortası yok. Motor ya **tam olarak bir dosyaya** işaret eden bir fact üretiyor (ilişki yok), ya da bir route'un **bütün transitif import closure'ına** işaret ediyor (yön yok, sıra yok, gerekçe yok).

Somut örnek: `route:/kariyer` memory'si 32 dosyayı evidence gösteriyor — tüm captcha modülü dahil. Çünkü `/kariyer` sayfası `NewsletterForm`'u render ediyor, o da `@/lib/captcha` barrel'ını import ediyor. Ulaşılabilir, ama `/kariyer`'in rendering sınıflandırmasıyla **nedensel ilgisi yok**. Evaluation contract'ın "Citation correctness" metriği bu yüzden route memory'lerinde geçerli değil: atıf yapılan dosya iddiayı desteklemiyor.

Sonucu pilot genelinde ölçtük:

| Kapsam | Dosya | Oran |
| --- | ---: | ---: |
| `src` altındaki `.ts`/`.tsx` | 63 | — |
| **Focused fact'i olan** | 27 | **%43** |
| Yalnız geniş route closure'ı içinde anılan | 35 | %56 |
| Hiç memory'si olmayan | 1 | %2 |

Focused fact'i olmayan 35 dosya rastgele değil: `captcha-*`, `contact.ts`, `newsletter.ts`, `manifest.ts`, `about.ts`, `careers.ts`, `team.ts` ve bütün presentational component'ler. Yani **saf mantık modülleri ve sunum bileşenleri**. Analyzer yalnız fetch çağrısı, env key, cache direktifi, import ve SEO metadata için focused fact üretiyor; **modül sözleşmesi, export edilen fonksiyon davranışı, validation kuralı ve hata cevabı için hiçbir fact tipi yok.**

Flow, impact ve debug sorularının tam olarak bu dosyalar hakkında olması tesadüf değil. `missing-fact` sınıfının 7 benzersiz dosyasının **tamamı** bu gruptan.

## 4. Ölçüm sonuçları

### Vaka seviyesi birincil sınıf

| Sınıf | Vaka | ID'ler |
| --- | ---: | --- |
| `wrong-intent` | 4 | F03, I01, I02, I05 |
| `missing-fact` | 4 | F01, F02, P03, D01 |
| `agent-policy` | 2 | D07, N07 |
| `unsupported-inference` | 1 | E03 |
| temiz | 4 | E02, E08, F06, N03 |

### Dosya seviyesi (22 eksik evidence dosyası)

| Sınıf | Dosya | Benzersiz |
| --- | ---: | ---: |
| `missing-fact` | 11 | 7 |
| `ranking` | 7 | 6 |
| `wrong-intent` | 4 | 3 |

`missing-fact` dosyaları: `contact.ts`, `newsletter.ts`, `captcha-config.ts`, `captcha-headers.ts`, `captcha-registry.ts`, `get-captcha-token.ts`, `AgreementArticle.tsx` — hepsi bölüm 3'teki focused-fact boşluğunda.

### İkincil uyarılar

| Uyarı | Vaka |
| --- | ---: |
| `over-retrieval` | 9 |
| `missing-relation` | 7 |
| `ranking` (ikincil) | 4 |
| `route-misparse` | 2 |

## 5. İki sorgu hatasının gerçek kapsamı

Query understanding'deki iki hata tek başına 15 vakanın 6'sına dokunuyor:

**Ölü tip filtresi.** `understandQuery` bir kelime yakalayınca `memoryTypes`'ı **zorunlu filtreye** çeviriyor. 15 vakanın 6'sında filtre aktif oldu:

| Vaka | Çıkarılan tip | Sonuç |
| --- | --- | --- |
| RCE-F03 | `authentication` | Pilot'ta 0 memory → **tamamen boş pack** |
| RCE-F01 | `api_dependency` | validation/rendering fact'leri elendi |
| RCE-F02 | `api_dependency` | aynı |
| RCE-I02 | `api_dependency` | `next.config.ts`'in configuration/build fact'leri elendi |
| RCE-I05 | `api_dependency` | hcaptcha adapter'ın dependency/configuration fact'leri elendi |
| RCE-E08 | `cache`, `api_dependency` | tesadüfen doğru iki tip → başarılı |

Altıdan beşi zarar gördü. Tek başarı, ihtiyaç duyulan tiplerin tesadüfen seçilmesiydi. `authentication` ve `middleware` tipleri pilotta **sıfır** memory'ye sahip; bu iki kelimeyi içeren her soru sessizce boş dönüyor.

**Route misparse.** Regex, dosya yolunu ve düz metin parçasını HTTP route sanıyor:

| Vaka | Üretilen "route" | Gerçek route mu |
| --- | --- | --- |
| RCE-I01 | `/lib/legal-pages/manifest.ts` | hayır |
| RCE-F06 | `/component` | hayır |

Her ikisi de SQL route kanalını tetikleyip alakasız route satırları getiriyor ve token harcıyor.

## 6. Öncelik — maliyet/etki

| Sıra | Düzeltme | Etkilediği vaka | Neden önce |
| --- | --- | ---: | --- |
| 1 | **RCE-014/015** — tip çıkarımını filtreden boost'a çevir; route regex'ini dosya yolundan ayır | 6 | Tek dosyalık değişiklik (`understand.ts`), veri modeline dokunmuyor, en yüksek etki |
| 2 | **RCE-008** — `/` redirect regresyonu ve route runtime davranışı | 1 (strict) | Tek `unsupported-inference`; yanlış fact eksik fact'ten kötüdür |
| 3 | **RCE-010** — modül sözleşmesi / export davranışı fact tipi | 4 | 63 dosyanın 35'inin focused fact'i yok; flow ve debug soruları burada kilitli |
| 4 | **RCE-009/011** — tipli, yönlü kenar; route closure'ını evidence olarak kullanmayı bırak | 7 (ikincil) | Citation correctness'i geri kazandırır |
| 5 | **RCE-018** — abstention ve "yetersiz kanıt" alanı | 2 | Uydurmayı yapısal olarak engeller |
| 6 | **RCE-006/016** — placeholder ve gürültü memory'lerini retrieval'dan çıkar | 9 (ikincil) | `limit: 5` penceresinde doğrudan slot kazandırır |

## 7. Bu koşunun kapsamadıkları

Dürüstlük için açıkça kaydedilir:

- **`stale` hiç tetiklenmedi.** Suite indexed SHA = HEAD ile çalışıyor. Bu sınıfı ölçmek için eski bir indeks anlık görüntüsüne karşı ayrı vaka gerekiyor; mevcut 50 vakalık katalogda böyle bir vaka yok. **Suite boşluğu — RCE-021 ile birlikte eklenmeli.**
- **`missing-relation` hiç birincil olmadı.** Harness dosya recall'ü ölçüyor, kenar ölçmüyor; ilişki eksikliği her zaman önce bir focused fact eksikliği olarak görünüyor. Kenar seviyesinde ölçüm RCE-009 ontolojisi tanımlanmadan yapılamaz.
- **RCE-N03 "temiz" çıktı ama gerçek bir tasarım boşluğu var:** `memory_get_repository` yalnız `lastIndexedSha` veriyor; working tree'nin dirty olduğunu memory bilemez ve pack bunu söylemiyor. Bu, taksonominin sekiz sınıfına girmiyor — freshness ile tree-accuracy'nin ayrı kavramlar olması. RCE-026'ya taşındı.
- **Cevap seviyesi ölçülmedi.** Canlı agent A/B'si (RCE-002 faz 2) proje kararıyla atlandı. Dolayısıyla `agent-policy` sınıfı burada "motor abstention sinyali vermiyor" olarak ölçülüyor; "agent gerçekten uyduruyor mu" ölçülmüyor.

## 8. RCE-004'e devir

Context ekonomi sözleşmesi bu koşudan üç ayrıştırma gereksinimi devralıyor:

1. **MCP payload ≠ agent context.** Harness `chars/3.5` ölçüyor; tool tanımı maliyeti, cache read/write ve agent'ın açtığı source dosyaları ayrı kalemler.
2. **Ölçüm başına çift kayıt.** Aynı fact'in iki kanaldan (ör. route SQL satırı + rendering memory) dönmesi bugün iki kez sayılıyor; `duplicate retrieval` metriği kanonik entity olmadan hesaplanamıyor (RCE-005 bağımlılığı).
3. **Negatif tasarruf görünür olmalı.** E03, D07 ve F06'da motor source okumaktan pahalıya geldi. Ekonomi sözleşmesi medyan tasarrufun yanında **kaç vakada motorun kaybettiğini** birinci sınıf metrik yapmalı.
