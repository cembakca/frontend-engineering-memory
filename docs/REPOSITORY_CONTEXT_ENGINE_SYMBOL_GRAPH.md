# RCE-010 — Symbol/component graph extraction

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/analyzers/symbol-graph.ts`](../src/analyzers/symbol-graph.ts)  
**Test:** [`test/symbol-graph.test.ts`](../test/symbol-graph.test.ts) — 8 vaka  
**Durum:** çıkarıcı çalışıyor ve pilot üzerinde doğrulandı; şemaya bağlama bütüncül migration'da (RCE-005 ile birlikte)

## 1. Ne yapıldı

Dosya seviyesi import grafiğinin üstüne sembol seviyesi bir çıkarıcı eklendi. TypeScript AST'sinden yedi kenar tipi üretiyor: `exports`, `calls`, `renders`, `references`, `reads`, `fetches`, `submits-to`.

Pilot üzerinde ürettiği kenarlar:

| Kenar | Adet |
| --- | ---: |
| `exports` | 121 |
| `references` | 159 |
| `calls` | 103 |
| `renders` | 85 |
| `reads` | 10 |
| `fetches` | 4 |
| `submits-to` | 2 |
| **Toplam** | **484** |

63 kaynak dosya için 484 tipli, yönlü, kanıt konumu taşıyan kenar — bugünkü modelin sunduğu şey ise dosya seviyesi erişilebilirlik listeleriydi.

## 2. Çözülen üç yapısal problem

### 2.1 Sabit çözümü — `submits-to` artık kurulabiliyor

RCE-003'ün flow vakalarını kıran şey buydu. Depolanan fact şunu diyordu:

```text
src/components/contact/ContactForm.tsx performs a fetch data call with target INSERT_COMMENT_URL.
```

`INSERT_COMMENT_URL` sabitinin değeri hiçbir yerde yoktu, dolayısıyla component → route handler kenarı kurulamıyordu. Çıkarıcı artık sabiti çözüyor:

```text
submits-to  src/components/contact/ContactForm.tsx#handleSubmit
         -> /api/pages/aboutus/insertcomment   [derived / constant-resolution]  ContactForm.tsx:380
```

`confidence` bilinçli olarak `derived`, `derivationRule` ise `constant-resolution` (RCE-007). Doğrudan string literal verilseydi `observed` olurdu.

### 2.2 Barrel re-export'u takip ediliyor

RCE-009'da ölçülen sorun: `@/lib/captcha` barrel'ı bütün modülü yeniden export ettiği için `ContactForm`'un 14 dosyalık closure'ı oluşuyordu. Çıkarıcı `export { x } from "./y"` zincirini takip ediyor:

```text
calls  src/components/contact/ContactForm.tsx#handleSubmit
    -> src/lib/captcha/get-captcha-token.ts#getCaptchaAuth
```

Kenar barrel'a değil, sembolü gerçekten tanımlayan modüle gidiyor.

### 2.3 Config anahtarı endpoint şablonunda korunuyor

```text
fetches  src/app/api/pages/aboutus/insertcomment/route.ts#POST
      -> POST ${GATEWAY_URL}/pages/aboutus/insertcomment
```

Değer gömülmüyor; `GATEWAY_URL` entity'si görünür kalıyor, böylece config impact sorusu (RCE-I02) endpoint üzerinden yürünebiliyor.

## 3. Uygulamanın ontolojiye geri beslediği kenar: `references`

İlk çalıştırmada **RCE-I05 çözülmedi** — hcaptcha adapter'ından geriye yürüyünce yalnız kendi dosyası çıktı. Neden:

```ts
const adapters: Record<CaptchaProviderId, CaptchaAdapter> = { hcaptcha: hcaptchaAdapter };
export function resolveCaptchaAdapter(id) { return adapters[id] ?? null }
```

`hcaptchaAdapter` bir record literalinde **referans veriliyor**, hiç çağrılmıyor. `calls` kenarı bu bağı kuramaz.

RCE-009 ontolojisi dinamik dispatch'i sınır olarak öngörmüştü ama kenar tanımlamamıştı. Uygulama bu boşluğu gösterdi ve ontolojiye `references` kenarı eklendi:

> Value pozisyonunda kullanılan, çağrılmayan imported sembol. `calls`'tan zayıf, ama `imports`'tan farklı olarak **sembol hassasiyetinde**.

İki ek düzeltme gerekti:

1. **Modül seviyesi binding bir node'dur.** `const adapters = {...}` başlangıçta node sayılmıyordu, zincir orada kopuyordu. Kural: fonksiyon gövdesi içindeki `const` node değildir, modül seviyesindeki `const` node'dur.
2. **Aynı-modül referansları kaydedilir.** `resolveCaptchaAdapter` → `adapters` bağı olmadan zincir yine kopuyordu.

Sonrasında I05 doğru cevabı veriyor.

## 4. Pilot doğrulaması — impact sorularının önce/sonrası

Ters closure (`calls`, `renders`, `references`, `reads`, `fetches`, `submits-to` üzerinden):

| Vaka | RCE-002'de | Şimdi |
| --- | --- | --- |
| **I01** legal manifest | Alakasız `insertcomment`/`subscribes` sonuçları (`wrong-intent`) | **8 dosya**: `manifest.ts`, `agreements.ts`, `[slug]/page.tsx`, üç agreements component'i, `SiteChrome`, `layout` |
| **I05** hcaptcha adapter | Adapter ve registry hiç getirilmedi (`wrong-intent`) | **5 dosya**: adapter → registry → `get-captcha-token` → `ContactForm` + `NewsletterForm` |
| **I02** GATEWAY_URL | Boş dependency listesi + route dökümü | `reads` `gateway.ts:9` + dört `fetches` kenarı, hepsi endpoint şablonuyla |
| **F01/F02** akış | Parçalar bulundu, zincir kurulamadı | `handleSubmit` → `parseContactForm` → `validateContactForm` → `getCaptchaAuth` → `submits-to` → handler → `fetches` upstream |

63 dosyalık repo'da I05 için **5**, I01 için **8** dosya dönüyor. Aynı sorular import closure'ı ile sorulsaydı 20–30 dosya dönerdi.

### Beklenenden sapan bir sonuç

RCE-002'de I05'in beklenen evidence'ına iki API handler'ı da yazılmıştı. Graph onları **döndürmüyor** ve bu doğru: handler'lar `captcha-headers.ts`'i kullanıyor, adapter'ı değil. Client tarafındaki adapter değişikliği handler'ları kod olarak etkilemiyor; ancak token formatı değişirse etkilerdi ki bu bir runtime sözleşmesi, kod kenarı değil. Evaluation vakasının beklentisi bu yönde düzeltilmelidir.

## 5. Bilinen sınırlar

- **`references` en zayıf davranışsal kenardır** (159 kenarla en kalabalığı). Traversal'da (RCE-012) `calls`/`renders`'tan düşük ağırlıklandırılmalı, yoksa impact kümesi gereksiz genişler.
- **Tip pozisyonları kısmen eleniyor.** `TypeReferenceNode` atlanıyor, ama tip-only import'lar ayrıca işaretlenmiyor.
- **Dinamik dispatch `condition` niteliği taşımıyor.** `adapters[id]` kenarı `observed` olarak yazılıyor; ontolojinin öngördüğü `condition` alanı henüz doldurulmuyor.
- **Method çağrıları alıcıya bağlanıyor.** `hcaptchaAdapter.execute()` kenarı `#hcaptchaAdapter`'a gider, `#execute`'a değil — üye seviyesi çözüm tip bilgisi gerektirir.
- **Şemaya yazılmıyor.** Çıkarıcı saf bir fonksiyon; `entities`/`edges` tablolarına bağlanması RCE-005 migration'ıyla birlikte yapılacak.

## 6. Testler

8 vaka, hepsi gerçek pilot pattern'lerinden türetildi: barrel re-export çözümü, sabit çözümü ile `submits-to`, template'te config anahtarının korunması, kenarın kapsayan fonksiyona atfı, `renders` ve component sınıflandırması, veri sabitine `calls` kenarı **çıkmaması**, dispatch table zinciri, ve iç binding'in node olmaması.

Tam suite: **37 test, 0 hata.**
