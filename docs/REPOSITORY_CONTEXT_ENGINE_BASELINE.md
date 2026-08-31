# RCE-002 — Memory açık/kapalı A/B baseline

**Koşu:** 31 Ağustos 2026  
**Pilot:** `hangikredi.aboutus.fe.next`  
**Target SHA:** `6d5978b3b82ea1734868a4b2ccf870f40e389d14` (HEAD = indexed SHA)  
**Working tree:** dirty (`M AGENTS.md`) — RCE-N03 için gerçek koşul  
**Suite:** [`config/context-engine-eval.json`](../config/context-engine-eval.json)  
**Runner:** `pnpm memory context-eval` → [`src/retrieval/context-eval.ts`](../src/retrieval/context-eval.ts)  
**Ham çıktı:** `eval-results/rce-002-run-1.json`

## 1. Bu koşu neyi ölçer, neyi ölçmez

Evaluation contract iki temiz oturumda agent A/B ister. Bu ilk baseline onun **deterministik yarısıdır** ve tekrar çalıştırılabilir:

| Ölçülen | Nasıl |
| --- | --- |
| Engine context maliyeti | Her vakanın MCP tool planı çalıştırılır; dönen JSON karakteri ve `chars/3.5` token tahmini toplanır |
| Baseline context maliyeti | Memory'siz bir agent'ın açmak zorunda olduğu source dosyalarının gerçek byte'ı + tek seferlik tree discovery (`git ls-files src` = 3.183 karakter) |
| Required evidence recall | Beklenen evidence dosyası dönen payload'da geçiyor mu |
| Over-retrieval | Payload'da geçen ama beklenmeyen dosya atıfları |
| Latency | Tool başına ms |
| Freshness | HEAD, indexed SHA ve working tree durumu |

**Ölçülmeyen:** agent'ın gerçek cevabı. `answerScore` alanı harness tarafından boş bırakılır — bu koşuda cevap kalitesi, dönen payload'ın tek başına doğru cevabı üretmeye yetip yetmediği okunarak elle puanlandı (bölüm 3). Canlı agent A/B'si bölüm 6'daki run-book ile yapılacak.

**Baseline kasıtlı olarak iyimserdir:** memory'siz agent'ın *doğru dosyaları ilk denemede bulduğu* varsayılır. Gerçek arama/grep turları sayılmaz. Yani aşağıdaki tasarruf oranları alt sınırdır.

## 2. Toplam sonuçlar

| Metrik | Sonuç | Hedef | Durum |
| --- | --- | --- | --- |
| Vaka | 15 | 15 | — |
| Toplam tool çağrısı | 19 | — | — |
| Engine context | 18.229 token | — | — |
| Baseline context | 81.059 token | — | — |
| Median context tasarrufu | **%84,4** | ≥ %40 | ✅ |
| Baseline source dosyası | 59 | — | — |
| Mean required-evidence recall | **0,54** | ≥ 0,90 | ❌ |
| Strict vaka doğruluğu | **1/7 (%14)** | %100 | ❌ |
| p50 tool latency | 9 ms | — | ✅ |

Tek cümleyle: **motor ucuz, ama henüz güvenilir değil.** Token hedefi rahat karşılanıyor; doğruluk hedefi karşılanmıyor. Bu koşunun asıl değeri tasarruf oranı değil, aşağıdaki dokuz kök nedeni kanıtlamasıdır.

## 3. Vaka vaka sonuç

| ID | İş | Engine tok | Baseline tok | Tasarruf | Recall | Cevap | Miss sınıfı |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| RCE-E03 | lookup | 1.028 | 968 | **−%6,2** | 1,00 | **hayır** | `missing-fact` → `unsupported-inference` |
| RCE-F01 | flow | 849 | 10.035 | %91,5 | 0,40 | kısmi | `missing-relation`, `wrong-intent` |
| RCE-F03 | flow | 88 | 5.383 | %98,4 | **0,00** | **hayır** | `wrong-intent` (boş pack) |
| RCE-I01 | impact | 4.197 | 5.402 | %22,3 | 0,25 | **hayır** | `wrong-intent`, `over-retrieval` |
| RCE-D07 | debug | 1.540 | 1.313 | **−%17,3** | 0,00 | kısmi | `missing-fact` |
| RCE-E02 | lookup | 728 | 5.582 | %87,0 | 1,00 | **evet** | — |
| RCE-E08 | lookup | 809 | 2.341 | %65,4 | 1,00 | kısmi | `missing-relation` |
| RCE-F02 | flow | 861 | 8.144 | %89,4 | 0,75 | kısmi | `missing-relation` |
| RCE-F06 | flow | 3.252 | 1.965 | **−%65,5** | 1,00 | **evet** | (maliyet) |
| RCE-I02 | impact | 1.131 | 4.776 | %76,3 | 0,60 | kısmi | `agent-policy`, `wrong-intent` |
| RCE-I05 | impact | 893 | 14.330 | %93,8 | 0,67 | kısmi | `missing-fact` |
| RCE-P03 | impl. | 883 | 12.058 | %92,7 | 0,40 | **hayır** | `missing-fact`, `over-retrieval` |
| RCE-D01 | debug | 1.083 | 6.942 | %84,4 | 0,00 | **hayır** | `missing-fact` |
| RCE-N03 | negative | 103 | 910 | %88,7 | — | kısmi | tasarım boşluğu |
| RCE-N07 | negative | 784 | 910 | %13,9 | — | kısmi | `agent-policy` |

Dağılım: **2 doğru, 8 kısmi, 5 yanlış.**

## 4. Kanıtlanan kök nedenler

Bunların hepsi bu koşuda doğrudan reprodüksiyonla gösterildi.

### 4.1 Query type çıkarımı hard filter, boost değil — `src/retrieval/understand.ts`

`TYPE_TERMS` bir kelime yakalarsa `memoryTypes` **zorunlu filtreye** dönüşür ve hem FTS hem vector kanalını daraltır.

RCE-F03 sorusunda geçen tek bir `token` kelimesi `authentication` tipini seçti. Pilot'ta **0 adet** `authentication` memory var (`middleware` de 0). Sonuç: 88 token'lık **tamamen boş** context pack. Motor "bilmiyorum" bile demiyor; sessizce hiçbir şey döndürmüyor.

Aynı mekanizma F01, F02, I05 ve I02'yi tek başına `api_dependency`'ye kilitledi; bu yüzden validation, cache ve config fact'leri hiç değerlendirilmedi. Recall kaybının en büyük tek nedeni budur.

### 4.2 Route regex'i dosya yolunu route sanıyor

`understandQuery` çıktısı:

- `"src/lib/legal-pages/manifest.ts değişirse..."` → `route = /lib/legal-pages/manifest.ts`
- `"Global menü hangi layout/component zinciriyle..."` → `route = /component`

Her ikisi de SQL route kanalını tetikleyip alakasız route satırları getiriyor. RCE-I01'in ilgisiz `insertcomment`/`subscribes` sonuçları ve önceki oturumda gözlenen "route kelimesi görünce route listesi" davranışı buradan geliyor.

### 4.3 Sembol değeri hiç çözülmüyor — flow zincirini kıran asıl eksik

Depolanan fact:

```text
src/components/contact/ContactForm.tsx performs a fetch data call with target INSERT_COMMENT_URL.
```

`INSERT_COMMENT_URL` sabitinin değeri (`/api/pages/aboutus/insertcomment`) hiçbir yerde saklanmıyor. Bu yüzden component → route handler kenarı kurulamıyor ve F01/F02 "parçaları buldu ama akışı bağlayamadı" durumunda kalıyor. Aynı sorun cross-file sabitlerde de var: `menu.ts` `GATEWAY_REVALIDATE_SECONDS`'ı `gateway.ts`'den import ettiği için **menu.ts'e ait bir cache memory yok**; 900 saniye yalnızca `gateway.ts` üzerinden dolaylı çıkarılabiliyor (RCE-E08).

### 4.4 `memory_dependencies` tip sözlüğü tutmuyor

Tool `type` parametresini `dependencies.dependency_type` ile birebir karşılaştırıyor. Gerçek değerler: `config`, `http`, `internal-package`, `npm`. AGENTS.md "configuration ve package soruları için kullan" dediği için agent'ın doğal yazacağı `type: "configuration"` **sessizce boş liste** döndürüyor (RCE-I02'de 22 token). Filtresiz çağrı ise 2.994 token'lık ham dump veriyor (RCE-I01) — iki uç arasında kullanışlı bir orta yok.

### 4.5 Aynı kavram için iki paralel model

`GATEWAY_URL` hem 84 `configuration` memory'sinin içinde hem de 18 `config` dependency satırında duruyor; aynı key birden çok `.env*` dosyası için tekrar tekrar kaydedilmiş. Tek kanonik entity + çoklu occurrence yok. RCE-005'in gerekçesi bu koşuda somutlaştı.

### 4.6 Değer üretmeyen memory'ler retrieval slot'u yiyor

- `business_capability`: 9 kaydın hepsi `"exposes a user-facing page or route-handler capability; no unverified business purpose is inferred."` — bilgi içermeyen placeholder.
- `performance_observation`: RCE-P03 ve RCE-D01'de ilk sıralara `"contains performance-related pattern performance import react"` gibi kayıtlar geldi.

`limit: 5`'lik bir pack'te bu kayıtlar doğrudan doğru fact'in yerini alıyor. RCE-006'nın gerekçesi.

### 4.7 Davranışsal fact tipi yok

Motor "hangi dosya neyi fetch ediyor"u biliyor; "hangi koşulda hangi cevabı döndürüyor"u bilmiyor. RCE-D01 (`400 Captcha failed` → `readCaptchaFromBody` null döndürdüğünde) için 0 recall almasının nedeni eksik ranking değil, **böyle bir fact tipinin hiç var olmaması**. Aynı şekilde RCE-D07 için test/verification tipi yok (RCE-013), RCE-P03 için pattern/convention tipi yok.

### 4.8 Analyzer semantic correctness — RCE-E03 regresyonu duruyor

`/` route satırı hâlâ `rendering=isr`, 8 dependency ile kayıtlı. Kaynak dosyanın tamamı:

```tsx
export default function Page() {
  redirect("/hakkimizda");
}
```

Layout zincirinden miras alınan dependency'ler route'un kendi davranışıymış gibi sunuluyor. `lastIndexedSha == HEAD` olması bu hatayı gizliyor. **RCE-008 kapanana kadar bu vaka kırmızı kalır.**

### 4.9 Abstention ve freshness sözleşmesi yok

- RCE-N07'de motor `repository_profile`, `build` ve `seo` fact'leri döndürüp `"Answer from these facts first"` diyor. "Bu soru bu veri modelinde cevaplanamaz" sinyali yok; agent'ı uydurmaya iten yapı bu.
- RCE-N03'te `memory_get_repository` yalnız `lastIndexedSha` veriyor. Working tree'nin dirty olduğu bilgisi memory'de yok ve olamaz da — ama pack bunu **söylemiyor**. Doğru cevap ancak agent kendi `git status`'unu çalıştırırsa çıkıyor.

## 5. Maliyet tarafındaki üç negatif vaka

Tasarruf her yerde geçerli değil:

| Vaka | Neden pahalı |
| --- | --- |
| RCE-E03 (−%6,2) | `memory_get_route` 8 dependency + layout chain + evidence dökıyor; cevap tek satırlık bir dosyada. Üstelik yanlış. |
| RCE-D07 (−%17,3) | İki tool çağrısı, sıfır ilgili fact; `package.json` okumak daha ucuz ve doğru. |
| RCE-F06 (−%65,5) | Doğru cevap veriyor ama `memory_get_route` + `memory_search` toplamı, üç kaynak dosyayı okumaktan pahalı. |

Çıkarım: **context pack görev tipine göre şekillendirilmeli.** Sabit "route'un her şeyini döndür" davranışı küçük sorularda net kayıp. RCE-017'nin ölçülmüş gerekçesi budur.

## 6. Faz 2 — canlı agent A/B run-book

Adım adım komutlar, oturum başlatma ve kopyala-yapıştır sorular: [`docs/RCE-002-AB-RUNBOOK.md`](RCE-002-AB-RUNBOOK.md). Sonuç şablonu: `eval-results/rce-002-live-ab.md`.

Harness cevap davranışını ölçemez. Aşağıdaki beş vaka, cevap seviyesinde en yüksek sinyali veren ve harness'ın ölçemediği soruyu soranlardır: **agent yanlış/boş context ile karşılaşınca toparlıyor mu, yoksa uyduruyor mu?**

| # | Vaka | Cevap seviyesinde test ettiği şey |
| --- | --- | --- |
| 1 | RCE-E03 | Agent yanlış `isr` fact'ini source ile doğrular mı, yoksa aktarır mı? |
| 2 | RCE-F03 | Boş pack gelince hedefli source fallback'e geçer mi? |
| 3 | RCE-I01 | Alakasız route sonuçlarını reddeder mi? |
| 4 | RCE-D07 | Kanıt yokken boşluğu bildirir mi, `.env.test`'e mi sapar? |
| 5 | RCE-N07 | Abstain eder mi, gerekçe uydurur mu? |

Protokol — her vaka için **iki temiz oturum**, aynı model ve aynı reasoning ayarı:

- **A / baseline:** `frontend-memory` MCP kapalı. Pilot repo'da normal source araçları.
- **B / context-engine:** MCP açık, `AGENTS.md` memory-first bloğu yüklü.

Oturum başına kaydedilecekler (contract bölüm 8 şablonu):

```text
case_id / variant / model / target_sha
task_correct: yes | partial | no
unsupported_claims: <sayı ve alıntı>
source_files_opened: <liste>
mcp_tools_called: <liste>
reported_input_tokens / output_tokens   (Claude'da /context ve /usage)
latency_seconds
fallback: none | appropriate | missing | excessive
```

Kural: oturumlar arasında konuşma context'i taşınmaz; repo aynı SHA'da kalır; `AGENTS.md`'deki uncommitted değişiklik olduğu gibi bırakılır (RCE-N03 için gerçek koşul).

## 7. RCE-003'e devredilen taksonomi girdisi

> **Güncelleme (31 Ağu 2026):** RCE-003 tamamlandı ve sınıflandırma bu tablodaki elle yapılmış tahminin yerine harness'ta ölçülür hale geldi. Güncel ve bağlayıcı sonuç: [`REPOSITORY_CONTEXT_ENGINE_MISS_TAXONOMY.md`](REPOSITORY_CONTEXT_ENGINE_MISS_TAXONOMY.md). Aşağıdaki tablo ilk okumanın kaydı olarak durur.


| Sınıf | Vaka | Doğrudan bağlı TODO |
| --- | --- | --- |
| `wrong-intent` | F03, I01, I02, F06, F01 | RCE-014, RCE-015 |
| `missing-relation` | F01, F02, E08 | RCE-009, RCE-010, RCE-011 |
| `missing-fact` | D01, D07, P03, I05, E03 | RCE-008, RCE-013, RCE-017 |
| `over-retrieval` | I01, P03, D01 | RCE-006, RCE-016 |
| `agent-policy` | N07, I02 | RCE-018, RCE-019 |
| `unsupported-inference` | E03 | RCE-007, RCE-008 |
| freshness/tasarım | N03 | RCE-026 |

`stale` ve `ranking` bu 15 vakada tek başına kök neden olarak görülmedi; ranking sorunları her seferinde bir hard filter veya değersiz memory'nin ardından ikincil etki olarak ortaya çıktı.

## 8. Kabul kararı

RCE-001 başarı eşikleri **karşılanmadı** (recall 0,54 < 0,90; strict doğruluk %14 < %100). Contract'ın kuralı gereği graph, embedding veya AI enrichment yatırımı henüz başarılı sayılamaz ve ikinci pilot açılamaz (RCE-028).

Bu koşunun kanıtladığı öncelik sırası:

1. **RCE-014/015** — type çıkarımını filtreden boost'a çevir, route regex'ini dosya yolundan ayır. En düşük maliyetli, en yüksek etkili düzeltme.
2. **RCE-008** — `/` redirect regresyonu.
3. **RCE-010** — sabit/sembol değer çözümü; flow zincirini kuran tek eksik.
4. **RCE-006** — placeholder ve gürültü memory'lerini retrieval'dan çıkar.
5. **RCE-018/019** — abstention sözleşmesi ve `memory_dependencies` tip sözlüğü.
