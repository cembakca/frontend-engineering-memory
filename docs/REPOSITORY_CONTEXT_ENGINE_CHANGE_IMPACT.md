# RCE-012 — Change-impact traversal

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/retrieval/impact.ts`](../src/retrieval/impact.ts)  
**Test:** [`test/impact.test.ts`](../test/impact.test.ts) — 5 vaka  
**Durum:** ters traversal çalışıyor ve pilotun üç impact sorusunda doğrulandı

## 1. Sözleşme

`affected-by` veritabanına yazılmaz. Bir file, symbol veya config seed'i için aşağıdaki semantic kenarlar sorgu anında ters yürünür:

```text
calls, renders, reads, fetches, inherits, submits-to, references, delegates-to
```

`imports` bilinçli olarak yoktur: bir modüle erişebilmek o modülün davranışından etkilenmek değildir. `exports` da traversal kenarı değildir; file seed verildiğinde o dosyanın graph'ta görünen bütün symbol'leri başlangıç kümesine alınır.

Her sonuç adımı `affected`, `via`, `dependency`, `file`, `line`, `confidence` ve varsa `derivationRule` taşır. Böylece closure yalnız bir dosya listesi değil, her etki iddiasının yönünü ve kanıt konumunu veren bir zincirdir.

`validated-by` ontolojide production entity → test yönündedir. Dependency closure ters yürürken test ilişkisi ayrıca ileri yönde toplanır. Test extraction RCE-013'ün kapsamıdır; traversal şimdiden bu kenarı tüketebilir.

## 2. Çıktı yüzeyleri

```ts
interface ImpactTrace {
  seed: string;
  steps: ImpactStep[];
  files: string[];
  symbols: string[];
  components: string[];
  routes: string[];
  apiRoutes: string[];
  config: string[];
  endpoints: string[];
  tests: string[];
  truncated: boolean;
}
```

Route sınıflandırması route analyzer'ın `route`, `sourceFile`, `routeType` kayıtlarıyla yapılır. Bir handler symbol'ü closure'a girdiğinde hem route hem `apiRoutes` içinde görünür. Affected symbol'lerin dış etkileri ayrıca okunur; bu yüzden `GATEWAY_URL` sonucunda handler'ların çağırdığı upstream endpoint şablonları kaybolmaz.

Traversal BFS kullanır. `maxDepth` (varsayılan 8) ve `maxSteps` (varsayılan 100) sınırlarından biri keserse `truncated: true` döner. Cycle'lar entity başına tek ziyaretle durdurulur.

## 3. Pilot ölçümü

Pilot graph bu ölçümde `next.config.ts` dahil 66 kaynak dosya ve 500 kenardı.

| Vaka | Seed | Sonuç |
| --- | --- | --- |
| I01 | `src/lib/legal-pages/manifest.ts` | 11 adım; `/[slug]`, `agreements.ts`, `AgreementArticle`, `AgreementSidebar`, `LegalSubNav`; ayrıca gerçek ters render zincirindeki `SiteChrome` ve root layout |
| I02 | `GATEWAY_URL` | 18 adım; iki API handler, `gateway.ts`, `menu.ts`, `next.config.ts`, dört upstream endpoint ve 8 route |
| I05 | `src/lib/captcha/providers/hcaptcha-adapter.ts` | 7 adım; `captcha-registry#adapters` → `resolveCaptchaAdapter` → `executeCaptcha` → `getCaptchaAuth` → newsletter/contact submit handler'ları |

I02'de config seed'in kendisi `config` yüzeyinde tutulur; `next.config.ts` aynı zamanda başka env anahtarları okuyor diye bu bağımsız kardeş anahtarlar sonuçlara eklenmez.

## 4. I05 beklenti düzeltmesi

Önceki evaluation cümlesi iki POST handler'ın hCaptcha adapter'a bağımlı olduğunu söylüyordu. Graph bunu döndürmedi ve source incelemesi bunun doğru davranış olduğunu gösterdi:

- İki form `getCaptchaAuth` üzerinden client adapter'a bağlıdır.
- İki route handler adapter'ı import etmez veya çağırmaz; gelen captcha alanlarını `captcha-headers.ts` ile upstream header'larına çevirir.
- `submits-to` formdan route'a gider. Bunu ters closure içinde ileri yürümek, handler'ın adapter'a dependency'si varmış gibi yanlış yönlü bir iddia üretirdi.

Bu nedenle I05 evaluation beklentisi “iki client flow etkilenir, handler'lar doğrudan etkilenmez” olarak düzeltildi. Handler contract uyumluluğu ayrı bir flow/change-review sorusudur.

## 5. Açık sınırlar

- `inherits`, `delegates-to` ve `validated-by` traversal tarafından destekleniyor; bunların tam extraction'ı sırasıyla analyzer correctness ve RCE-013 işidir.
- Dynamic property dispatch yalnız RCE-010'un ürettiği symbol-precise `references` zinciri kadar izlenebilir.
- Bu katman query niyeti seçmez ve MCP yüzeyi sunmaz; RCE-014–019 compiler katmanları bu primitive'i çağıracaktır.
