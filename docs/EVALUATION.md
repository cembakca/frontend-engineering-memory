# Evaluation contract

This contract defines the task-level acceptance suite for retrieval correctness, evidence quality, abstention, and context economy. The checked-in catalog is a reference pilot; each new repository shape should contribute real questions and evidence expectations to `config/context-engine-eval.json`.

## 1. Amaç

Bu evaluation yalnız “ilgili memory ilk beşte mi?” sorusunu ölçmez. Context engine'in doğru görevi anlayıp anlamadığını, gerekli kanıtı getirip getirmediğini, agent'ın desteksiz iddia üretip üretmediğini ve source okumaya kıyasla gerçek context tasarrufunu ölçer.

Mevcut üç retrieval vakası smoke test olarak kalabilir; ürün kabulü için yeterli değildir.

## 2. Core invariants

- `lastIndexedSha == HEAD` proves snapshot freshness, not semantic correctness.
- Evidence presence does not prove that a fact interpreted the source correctly.
- Route runtime behavior and inherited dependency/impact relationships are distinct.
- A cheap pack that is wrong does not replace source reading.
- Unsupported rationale, ownership, runtime, or incoming-consumer claims must abstain.

## 3. Evaluation birimi

Her vaka şu alanlara sahip olmalıdır:

| Alan | Anlamı |
| --- | --- |
| Case ID | Değişmeyen kimlik |
| Job | `lookup`, `flow`, `impact`, `implementation`, `debug`, `change`, `negative` |
| Question | Agent'a aynen verilecek soru |
| Expected evidence | Cevabı doğrulayabilecek minimum source seti |
| Expected policy | Memory yeterli olmalı, targeted source açılmalı veya agent abstain etmeli |
| Strict fact | Yanlış cevap verilmesi kabul edilemeyen çekirdek gerçek |

## 4. A/B çalıştırma protokolü

Her vaka aynı model ve reasoning ayarıyla iki temiz oturumda çalıştırılır:

1. **Baseline:** `frontend-memory` kapalı; agent normal source araçlarını kullanır.
2. **Context Engine:** MCP açık ve memory-first talimatı yüklü.

Kurallar:

- Önceki vaka konuşma context'i taşınmaz.
- Repository aynı SHA'da ve clean olmalıdır; değilse durum kaydedilir.
- Tool transcript, açılan source dosyaları ve final cevap saklanır.
- Claude için `/usage` ve `/context`; kullanılabilir Codex session/context metriği ayrıca kaydedilir.
- MCP payload karakteri ve engine'in verdiği token tahmini model tokenından ayrı tutulur.
- Agent memory cevabı yeterli bulsa bile evaluator expected evidence ile fact doğruluğunu kontrol eder.

## 5. Ölçümler

| Metrik | Tanım |
| --- | --- |
| Task correctness | Vaka rubric'inin karşılanma oranı |
| Grounded fact precision | Evidence ile desteklenen factual claim / tüm factual claim |
| Required evidence recall | Context pack'te bulunan gerekli evidence / beklenen evidence |
| Citation correctness | Verilen file/symbol/range gerçekten iddiayı destekliyor mu? |
| Appropriate fallback | Memory yetersizken yalnız hedefli source'a geçildi mi? |
| Appropriate abstention | Kaynakta olmayan `why`, ownership veya runtime sonucu uydurulmadı mı? |
| Context input | MCP output + source/tool output model input tokenı |
| Source reads | Açılan benzersiz source dosyası sayısı |
| Duplicate retrieval | Aynı fact/dependency'nin gereksiz ikinci kez getirilmesi |
| Latency | İlk doğru evidence ve final answer süresi |
| Freshness | Cevabın kullandığı SHA'nın hedef snapshot ile eşleşmesi |

İlk kabul hedefleri:

- Strict lookup/freshness vakalarında `%100` doğruluk.
- Grounded fact precision `>= %98`.
- Required evidence Recall@5 `>= %90`.
- Appropriate abstention `>= %95`.
- Baseline'a göre median context input azalması `>= %40`.
- Baseline'a göre median source-file read azalması `>= %50`.
- Context tasarrufu uğruna task correctness düşmemeli.

## 6. Golden-question kataloğu

### Exact lookup ve strict facts — 10 vaka

| ID | Soru | Minimum evidence / structured source | Policy |
| --- | --- | --- | --- |
| RCE-E01 | Projenin Next.js, React ve Node sürümleri ile router türü nedir? | `package.json`, runtime/build config | Memory yeterli |
| RCE-E02 | Bütün aktif HTTP route'larını ve source dosyalarını listele. | Structured routes + route tree | Memory yeterli |
| RCE-E03 | `/` isteği gerçekte ne yapıyor? | `src/app/page.tsx` | **Strict:** `/hakkimizda` redirect; içerik ISR cevabı başarısızdır |
| RCE-E04 | `/iletisim` hangi dosyadan gelir ve rendering sinyali nedir? | `src/app/iletisim/page.tsx` | Memory yeterli; `force-static` kanıtlanmalı |
| RCE-E05 | Dynamic legal/content route hangisidir ve slug nerede çözülür? | `src/app/[slug]/page.tsx`, `src/lib/agreements.ts`, manifest | Memory + gerekirse targeted source |
| RCE-E06 | Hangi route handler'lar POST kabul ediyor? | İki `src/app/api/**/route.ts` dosyası | Memory yeterli |
| RCE-E07 | Root layout metadata ve origin hangi kaynaklardan gelir? | `src/app/layout.tsx`, `src/lib/site-origin.ts` | Memory yeterli |
| RCE-E08 | Menü hangi upstream endpoint'ten gelir ve cache süresi nedir? | `src/lib/menu.ts` | Memory yeterli |
| RCE-E09 | `HOST` ile `NEXT_PUBLIC_HOST` nerede ve hangi öncelikle kullanılır? | `src/lib/site-origin.ts` | Gerekirse tek targeted source |
| RCE-E10 | Next build output klasörü nedir ve nerede tanımlanır? | `next.config.ts`, package clean script | Memory yeterli; generated output source sayılmamalı |

### End-to-end flow — 10 vaka

| ID | Soru | Minimum evidence | Policy |
| --- | --- | --- | --- |
| RCE-F01 | İletişim formu kullanıcı girdisini upstream backend'e hangi sırayla gönderiyor? | `ContactForm.tsx` → `contact.ts`/captcha → insertcomment handler → `gateway.ts` | Sıralı graph/context pack beklenir |
| RCE-F02 | Newsletter aboneliği UI'dan backend'e hangi sırayla gider? | `NewsletterForm.tsx` → `newsletter.ts`/captcha → subscribes handler → gateway | Sıralı graph/context pack beklenir |
| RCE-F03 | Contact captcha tokenı nasıl üretilip upstream header'a dönüşüyor? | captcha registry/adapter/auth + headers + contact handler | Tek config key cevabı başarısızdır |
| RCE-F04 | Subscribe captcha akışı contact akışından nerede ayrılır? | İki form, captcha çağrıları ve iki handler | Karşılaştırmalı flow beklenir |
| RCE-F05 | `/hakkimizda` içeriği nereden gelir ve hangi cache politikasını kullanır? | page + `about.ts`/`gateway.ts` | Memory + relation evidence |
| RCE-F06 | Global menü hangi layout/component zinciriyle tüm sayfalara ulaşır? | layout → `SiteChrome.tsx` → `menu.ts` | Memory graph yeterli olmalı |
| RCE-F07 | Legal agreement slug'ı HTML içeriğine nasıl dönüşür? | `[slug]/page.tsx` → `agreements.ts` → manifest → content file | Targeted context pack |
| RCE-F08 | Bir görsel public/CDN URL'sine nasıl dönüştürülür? | `CdnImage.tsx`, `cdn-path.ts`, `next.config.ts` | Flow evidence gerekli |
| RCE-F09 | İletişim adres/telefon/e-posta verisi sayfaya nasıl gelir? | `iletisim/page.tsx`, `contact.ts`, ilgili component | Memory veya targeted source |
| RCE-F10 | Canonical/absolute URL üretimi page metadata'ya nasıl bağlanır? | layout/page metadata + `site-origin.ts` | Relation evidence gerekli |

### Change impact — 8 vaka

| ID | Soru | Minimum evidence | Policy |
| --- | --- | --- | --- |
| RCE-I01 | `src/lib/legal-pages/manifest.ts` değişirse hangi route ve bileşenler etkilenir? | Reverse graph: manifest → agreements → `[slug]`/legal components | Rastgele route listesi başarısızdır |
| RCE-I02 | `GATEWAY_URL` davranışı değişirse hangi handler, fetch ve route'lar etkilenir? | Config occurrence + call/route graph | Kopya config memory'leri tek entity olmalı |
| RCE-I03 | `src/lib/menu.ts` değişirse hangi route'lar dolaylı etkilenir? | menu → SiteChrome → layout → active pages | Inheritance impact beklenir |
| RCE-I04 | `SiteChrome.tsx` değişikliğinin route kapsamı nedir? | Component → layout → routes | Graph beklenir |
| RCE-I05 | hCaptcha adapter değişirse hangi kullanıcı akışları ve API handler'lar risklidir? | Captcha graph + iki form + iki handler | Flow+impact pack |
| RCE-I06 | `@hangikredi/tokens` major update'i hangi source'ları etkileyebilir? | Package/import occurrences | Exact import graph |
| RCE-I07 | CDN env veya assetPrefix değişikliği hangi görüntü/build yollarını etkiler? | next config + cdn-path + CdnImage | Config→symbol graph |
| RCE-I08 | Tek bir legal HTML dosyasını değiştirirsem hangi public URL etkilenir? | Content file ↔ manifest slug ↔ `[slug]` | Ters mapping beklenir |

### Implementation planning — 7 vaka

| ID | Soru | Minimum evidence | Policy |
| --- | --- | --- | --- |
| RCE-P01 | Yeni statik kurumsal sayfa eklemek için hangi dosya pattern'i ve doğrulama adımları kullanılmalı? | Benzer page'ler, layout, scripts | Örnek seçimi + targeted source |
| RCE-P02 | Yeni legal agreement eklemek için nereler değişmeli? | content + manifest + slug route/components | Minimum edit seti |
| RCE-P03 | Yeni captcha korumalı form eklerken hangi mevcut pattern izlenmeli? | Contact/newsletter/captcha/handler örnekleri | Pattern ve farklar açıklanmalı |
| RCE-P04 | Yeni ISR gateway GET'i eklerken hangi cache ve error pattern'i izlenmeli? | gateway/menu/agreement fetch'leri | Benzerlik temelli plan |
| RCE-P05 | Yeni POST route handler eklerken validation, captcha ve upstream hata sözleşmesi nedir? | Mevcut iki handler | Plan; kopyalama değil ortak pattern |
| RCE-P06 | Yeni CDN-aware image component kullanımı için doğru yol nedir? | CdnImage + cdn-path + örnek imports | Targeted source gerektiğinde açılmalı |
| RCE-P07 | Bu repository'de değişiklikten sonra hangi komutlar çalıştırılabilir ve hangi test boşluğu var? | `package.json`, mevcut test dosyalarının yokluğu | Test varmış gibi davranmamalı |

### Debugging, validation ve security — 7 vaka

| ID | Soru | Minimum evidence | Policy |
| --- | --- | --- | --- |
| RCE-D01 | Contact form neden `400 Captcha failed` döndürebilir? | Form captcha result + handler body/header parsing | Koşullu debug path |
| RCE-D02 | Contact form neden `502 Contact upstream unreachable` döndürür? | Contact handler fetch/catch + gateway config | Exact failure condition |
| RCE-D03 | Newsletter neden `503 Subscribe upstream not configured` döndürür? | Subscribe handler + `GATEWAY_URL` | Exact failure condition |
| RCE-D04 | Canonical URL yanlışsa hangi config ve fonksiyon kontrol edilmeli? | `site-origin.ts` + metadata call sites | Minimum file seti |
| RCE-D05 | CDN görselleri bozuksa hangi config zinciri kontrol edilmeli? | cdn-path + next config + env key occurrences | Öncelikli debug steps |
| RCE-D06 | hCaptcha site key eksik veya provider unavailable ise UI davranışı nedir? | captcha config/adapter/messages/get-token + forms | Source gerekli; config listesi yetmez |
| RCE-D07 | Projenin error-handling ve automated-test stratejisi nedir? | Error boundaries/tests/scripts varlığı veya yokluğu | Kanıt yoksa açıkça boşluk bildir; `.env.test` cevabı başarısızdır |

### Change, freshness ve negative/abstention — 8 vaka

| ID | Soru | Minimum evidence | Policy |
| --- | --- | --- | --- |
| RCE-N01 | `d4e23dc` sonrasında hangi kullanıcı görünür davranışlar değişti? | Git diff + behavior facts/change audit | Dosya listesi yerine behavior diff; yetmiyorsa bildir |
| RCE-N02 | Memory hangi SHA'yı temsil ediyor ve hedef HEAD ile aynı mı? | Repository row + Git HEAD | `%100` exact |
| RCE-N03 | Working tree dirty ise memory “güncel” sayılabilir mi? | Git status + indexed SHA | SHA eşit olsa bile uncommitted source için uyarı |
| RCE-N04 | Bu projede Redux veya Zustand kullanılıyor mu? | package/import inventory | Yokluk kanıtı kapsamla birlikte ifade edilmeli |
| RCE-N05 | Middleware tabanlı auth hangi route'ları koruyor? | Middleware/routes/auth facts | Middleware yoksa “korunmuyor” sonucunu aşırı genelleme; yalnız sinyal yok de |
| RCE-N06 | Production observability sistemi nedir? | Kapsam + source evidence | Mevcut ürün kapsamı/yetersiz evidence nedeniyle abstain |
| RCE-N07 | Ekip neden Next.js 16'yı seçti? | ADR/PR/human-approved decision gerekir | Source code'dan `why` uydurma |
| RCE-N08 | Bu frontend'i hangi dış sistemler tüketiyor? | Incoming-consumer kaynağı gerekir | Mevcut kapsam dışı; açıkça abstain |

Toplam: **50 vaka**.

## 7. İlk 15 çalışma sırası

A/B baseline önce şu vakalarla yapılmalıdır:

1. RCE-E03
2. RCE-F01
3. RCE-F03
4. RCE-I01
5. RCE-D07
6. RCE-E02
7. RCE-E08
8. RCE-F02
9. RCE-F06
10. RCE-I02
11. RCE-I05
12. RCE-P03
13. RCE-D01
14. RCE-N03
15. RCE-N07

Bu sıra exact correctness, flow, impact, debug, negative/abstention ve token ekonomisini aynı küçük örneklemde kapsar.

## 8. Sonuç kayıt şablonu

Her koşu için aşağıdaki satır doldurulur:

```text
case_id:
variant: baseline | context-engine
client/model:
target_sha:
indexed_sha:
task_correct: yes | partial | no
grounded_claims:
unsupported_claims:
expected_evidence_found:
source_files_opened:
mcp_tools_called:
mcp_payload_chars:
reported_input_tokens:
reported_output_tokens:
latency_seconds:
fallback: none | appropriate | missing | excessive
miss_class:
notes:
```

Sonuçlar alınmadan graph, embedding veya AI enrichment yatırımlarının başarı sağladığı kabul edilmez.
