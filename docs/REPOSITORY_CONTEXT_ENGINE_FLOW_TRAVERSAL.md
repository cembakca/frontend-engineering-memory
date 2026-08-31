# RCE-011 — Flow traversal

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/retrieval/flow.ts`](../src/retrieval/flow.ts)  
**Test:** [`test/flow.test.ts`](../test/flow.test.ts) — 5 vaka  
**Durum:** traversal çalışıyor ve pilotun dört akışında doğrulandı

## 1. Problem: graph bir akış değildir

RCE-010 kenarları üretti, ama kenar kümesi bir cevap değil. `RCE-F01` "hangi **sırayla**" diye soruyor. İlk çalıştırmada saf DFS şunu üretti:

```text
 1. calls  contact.ts#parseContactForm
 2.   calls  contact.ts#readText
 3.   references  contact.ts#MAX_NAME_LENGTH
 4.   calls  contact.ts#readText
 ...
15.   calls  contact.ts#readChecked
16. calls  contact.ts#validateContactForm
```

22 adımın 15'i tek bir yardımcının iç detayı. Bütçe tükeniyor, captcha ve upstream hiç görünmüyor. Bu, RCE-003'ün `over-retrieval` sınıfının akış hâli.

## 2. Çözüm: iki eksenli sıralama + dal budama

**Sıralama.** Kardeş adımlar `startLine`'a göre sıralanır. Düz akışlı async kodda satır sırası yürütme sırasını yaklaşık verir; DFS de "önce şunu yapar, sonra şunu" anlatısını üretir. Kenar tipi yalnız aynı satırdaki eşitliği bozar.

**Budama.** Ağaç kurulur, sonra **anlamlı yaprağa ulaşmayan dallar atılır.** Bir adım şu koşullarda anlamlıdır:

| Koşul | Gerekçe |
| --- | --- |
| `submits-to`, `fetches`, `reads` | Dış dünyaya dokunuyor |
| Modül sınırı geçen `calls` / `renders` | Katman değiştiriyor |
| `references` | **Tek başına anlamlı değil** — yalnız altında anlamlı bir şey varsa kalır |

`parseContactForm → readText` aynı modül içinde kalır ve altında dışarı çıkan bir şey yoktur; düşer. `getCaptchaAuth → executeCaptcha` de aynı modüldedir ama altında `captcha-registry` ve `hcaptcha-adapter` vardır; kalır.

Bu ayrım önemli: aynı-modül adımlarını topluca elemek zinciri koparırdı.

## 3. Pilot çıktısı — RCE-F01

19 adım, **59 adım budandı**:

```text
 1. calls      contact.ts#parseContactForm                    ContactForm.tsx:339
 2. calls      contact.ts#validateContactForm                 ContactForm.tsx:340
 3. calls      get-captcha-token.ts#getCaptchaAuth            ContactForm.tsx:367
 4.   calls      get-captcha-token.ts#executeCaptcha          get-captcha-token.ts:77
 5.     calls      captcha-config.ts#resolveCaptchaOptions    get-captcha-token.ts:22
 6.     calls      captcha-registry.ts#resolveCaptchaAdapter  get-captcha-token.ts:23
 7.       references captcha-registry.ts#adapters             captcha-registry.ts:13
 8.         references hcaptcha-adapter.ts#hcaptchaAdapter    captcha-registry.ts:7
 9.           calls      hcaptcha-adapter.ts#resolveSiteKey   hcaptcha-adapter.ts:259
10.             reads      NEXT_PUBLIC_HCAPTCHA_SITE_KEY      hcaptcha-adapter.ts:75
11.             reads      NEXT_PUBLIC_HCAPTCHA_ALWAYS_CHALLENGE_KEY
12.   calls      captcha-messages.ts#messageForCaptchaReason  get-captcha-token.ts:85
13. submits-to /api/pages/aboutus/insertcomment  << İSTEMCİDEN SUNUCUYA
14.   calls      captcha-headers.ts#readCaptchaFromBody       route.ts:57
15.   references gateway.ts#GATEWAY_URL                       route.ts:62
16.     reads      GATEWAY_URL                                gateway.ts:9
17.   fetches    POST ${GATEWAY_URL}/pages/aboutus/insertcomment  route.ts:70
18.   calls      captcha-headers.ts#buildCaptchaHeaders       route.ts:78
19. calls      contact.ts#toInsertCommentPayload             ContactForm.tsx:387

upstream: POST ${GATEWAY_URL}/pages/aboutus/insertcomment
config  : NEXT_PUBLIC_HCAPTCHA_SITE_KEY, NEXT_PUBLIC_HCAPTCHA_ALWAYS_CHALLENGE_KEY, GATEWAY_URL
```

RCE-002'de bu soru "parçaları buldu fakat akışı birbirine bağlayamadı" sonucunu vermişti. Şimdi zincir istemciden upstream'e kadar kesintisiz, her adım `dosya:satır` ile.

`boundary: "client-to-server"` alanı, akışın tarayıcıdan çıkıp route handler'a geçtiği tek adımı işaretler. Bu, RCE-F03 ve RCE-D01 gibi soruların cevabının hangi tarafta olduğunu belirlemek için gereken ayrım.

## 4. Doğrulanan diğer akışlar

| Vaka | Sonuç |
| --- | --- |
| **F02** newsletter | 18 adım; F01 ile aynı captcha kolunu paylaşıyor, yalnız endpoint'te ayrılıyor — RCE-F04'ün karşılaştırma sorusu doğrudan okunabiliyor |
| **F06** global menü | `layout#RootLayout` → `getMenuList` → `GET ${GATEWAY_URL}/pages/menuitem/list?webVersionCode=2` → `getSiteOrigin` (`HOST`, `NEXT_PUBLIC_HOST`) → `renders SiteChrome` → `AboutSubNav`, `LegalSubNav` |
| **F07** legal slug → HTML | `[slug]#AgreementPage` → `isAgreementSlug` → `getAgreement` → `getAboutContent` → `fetchAboutPage` → upstream → `renders AgreementArticle` → `AgreementSidebar` |

İki farklı akış şekli de destekleniyor: UI→validation→captcha→handler→upstream ve page→layout→menu/cache.

## 5. Çıktı sözleşmesi

```ts
interface FlowTrace {
  seed: string;
  steps: FlowStep[];      // order, depth, from, edge, to, file, line, confidence, boundary?
  endpoints: string[];    // ulaşılan upstream endpoint'ler, ilk görülme sırasıyla
  config: string[];       // akışın bağlı olduğu config anahtarları
  prunedSteps: number;    // budanan adım sayısı — şeffaflık için
  truncated: boolean;
}
```

`prunedSteps` bilinçli olarak raporlanıyor: bir cevabın ne kadar detayı bilerek attığı, agent'ın "daha fazlası var mı" sorusunu cevaplaması için gerekli.

Her adım `confidence` taşır (RCE-007). `submits-to` adımı `derived`/`constant-resolution` gelir; akış anlatısı bunu kesin gerçek gibi sunamaz.

## 6. Bilinen sınırlar

- **Satır sırası yürütme sırası değildir.** Koşullu dallar, erken `return`'ler ve `Promise.all` sıralaması yansıtılmıyor. F01'in 19. adımı (`toInsertCommentPayload`, satır 387) aslında 13. adımdaki `fetch` çağrısının gövdesi içinde; satır numarası gösterildiği için yanıltıcı değil, ama sıra tam yürütme sırası değil.
- **Döngü ve tekrar eden çağrı gösterilmiyor.** `visited` kümesi her düğümü bir kez işler.
- **Koşul bilgisi yok.** "Captcha başarısızsa erken döner" gibi dallanma akışta görünmüyor; hata cevabı fact'leri RCE-013'ün konusu.
- **`inherits` kenarı yok.** Route→layout zinciri `scanRoutes`'un `layoutChain`'inden geliyor; F06 için layout doğrudan seed olarak verildi. Birleştirme RCE-017'de yapılacak.
- **MCP'ye bağlı değil.** `traceFlow` şu an bir kütüphane fonksiyonu; context-pack şeması RCE-017, tool yüzeyi RCE-019.

## 7. Bağımlılıklar

- **RCE-010** — kenarların kaynağı; `submits-to` olmadan istemci-sunucu geçişi kurulamaz.
- **RCE-012** — aynı kenar kümesi üzerinde ters yönlü yürüyüş.
- **RCE-016** — `references` kenarının düşük ağırlığı burada budama kuralıyla ele alındı; ranking sözleşmesinde de aynı ağırlık kullanılmalı.
- **RCE-017** — `FlowTrace` doğrudan `flow` context-pack şemasının gövdesidir.
