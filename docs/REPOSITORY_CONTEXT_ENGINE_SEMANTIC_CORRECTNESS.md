# RCE-008 — Analyzer semantic correctness paketi

**Tarih:** 31 Ağustos 2026  
**Paket:** [`test/semantic-correctness.test.ts`](../test/semantic-correctness.test.ts) — 8 vaka + open-gap defteri  
**Doğrulama kaynağı:** Next.js 16 dokümantasyonu (Context7, `/vercel/next.js/v16.2.9`)  
**Durum:** vakalar yazıldı, sekizi de açık — düzeltme bütüncül çözümde

## 1. Paket nasıl çalışıyor

Bunlar **characterization test**'leridir. Her vaka iki değer taşır:

- `expected` — doğru bir analyzer'ın üretmek zorunda olduğu semantik
- `current` — bu analyzer'ın bugün ürettiği değer

Assertion `current`'a karşı yapılır. Böylece boşluklar açıkken suite yeşil kalır, ama davranış **değiştiği anda** kırmızıya döner:

```text
not ok 2 - RCE-008-B — MANDATORY REGRESSION ...
    RCE-008-B behaviour changed.
      observed: redirect:/hakkimizda
      recorded: isr
      expected by the contract: redirect:/hakkimizda
    If this is the fix, promote `current` to `expected` and remove the id from OPEN_GAPS.
```

Ayrıca bir **open-gap defteri** testi var: açık vakaların kimlik listesi `OPEN_GAPS` sabitiyle karşılaştırılır. Bir boşluk kapandığında ya da yenisi açıldığında bu test de düşer. Sinyal mekanizması `RCE-008-B` üzerinde simüle edilerek doğrulandı; her iki test de beklendiği gibi düştü.

Kural: bir vakayı `expected`'ı değiştirerek susturmak yasaktır.

## 2. Bulunan kusurlar

### K1 — `next/navigation` kontrol akışı hiç modellenmiyor

`src/analyzers/routes.ts:72–111` içindeki `detectRendering`, `redirect()` ve `notFound()` için hiçbir dal içermiyor. Gövdesi yalnız `redirect()` olan bir sayfa, son satırdaki varsayılana düşüyor:

```ts
return { mode: "rsc", evidence: ["App Router page without detected dynamic trigger"] };
```

Sonuç: **redirect eden bir sayfa ile boş bir sayfa, kayıtta birbirinden ayırt edilemiyor** (vaka F).

### K2 — Erişilebilir modülün sinyali sayfanın açık direktifini eziyor

`routes.ts:229`, `behaviorFiles` kümesindeki her modül için `detectRendering` çalıştırıp `mergeRendering` ile **en yüksek öncelikli** modu alıyor. Öncelik tablosu (`routes.ts:115`): `static`=2 < `isr`=3 < `dynamic-ssr`=5.

Bu, sayfanın kendi route segment direktifini geçersiz kılıyor:

| Fixture | Sayfa direktifi | Yardımcı modül | Analyzer | Doğrusu |
| --- | --- | --- | --- | --- |
| C | `dynamic = "force-static"` | `cookies()` çağırıyor | `dynamic-ssr` | **`static`** |
| I | `dynamic = "force-static"` | `cache: 'no-store'` | `dynamic-ssr` | **`static`** |

Next.js 16 dokümanı bu konuda kesin:

> `'force-static'` forces prerendering and caches data by making `cookies`, `headers()`, and `useSearchParams()` return empty values.

`force-static` altında `cookies()` boş döner ve sayfa yine prerender edilir. Dolayısıyla `dynamic-ssr` sınıflandırması yalnız isabetsiz değil, **doğrudan yanlıştır**.

Vaka C'nin evidence çıktısı çelişkiyi kendi içinde taşıyor:

```json
["src/app/kariyer/page.tsx: explicit static/cache signal",
 "src/lib/session.ts: cookies()"]
```

Sayfanın direktifi kanıt listesinde duruyor, ama sonucu belirleyen yardımcı modül oluyor.

### K3 — Sayfa sınıflandırıcısı kütüphane modüllerine uygulanıyor

`detectRendering(behaviorContent, routerType)` çağrısı `menu.ts`, `gateway.ts`, `session.ts` gibi route olmayan modüller için de çalıştırılıyor. Bir yardımcı modülün rendering modu yoktur; sayfa sınıflandırıcısını ona uygulamak kategori hatasıdır. K1'in pilottaki görünümü ve K2'nin mekanizması budur.

### K4 — Route segment direktifi kayıtta saklanmıyor

`export const dynamic = "force-static"` yalnız `"explicit static/cache signal"` şeklinde belirsiz bir evidence dizesine dönüşüyor. Kayıtta direktifin kendisini taşıyan bir alan yok. Bu önemli, çünkü `force-static`'in kayıtta ifade edilmeyen sonuçları var (dinamik API'ler boş döner).

### K5 — Rewrite / route delegation modellenmiyor

Pilot'un `next.config.ts`'i iki namespace'i upstream'e delege ediyor:

```ts
{ source: "/api/pages/:path*",             destination: `${process.env.GATEWAY_URL}/pages/:path*` },
{ source: "/api/customer-services/:path*", destination: `${process.env.GATEWAY_URL}/customer-services/:path*` },
```

Route envanteri yalnız dosya sistemindeki 9 route'u gösteriyor. Uygulamanın gerçekte servis ettiği yüzey bundan geniş.

### K6 — Yokluktan varsayılan, kesin gerçek gibi kaydediliyor

`"App Router page without detected dynamic trigger"` bir gözlem değil, gözlem yokluğudur; kayıt bunu `basis` alanıyla işaretlemiyor. RCE-007'nin `basis: "default"` kuralı bu vakayı hedefler.

## 3. Vaka listesi

| ID | Konu | `expected` | `current` |
| --- | --- | --- | --- |
| RCE-008-A | Yalnız `redirect()` içeren sayfa | `redirect:/hakkimizda` | `rsc` |
| **RCE-008-B** | **Zorunlu regresyon — pilot `/`** | `redirect:/hakkimizda` | `isr` |
| RCE-008-C | `force-static` + `cookies()` çağıran yardımcı | `static` | `dynamic-ssr` |
| RCE-008-H | Segment direktifinin kayıtta korunması | `dynamic=force-static` | `directive not preserved` |
| RCE-008-D | `notFound()` çağıran sayfa | `not-found:conditional` | `no not-found signal` |
| RCE-008-E | `rewrites()` ile delege edilen namespace | `delegated:/api/pages/:path*` | `only filesystem routes` |
| RCE-008-F | Redirect sayfası ile boş sayfa ayrımı | `distinguishable` | `identical` |
| RCE-008-G | Yokluktan varsayılan işaretlemesi | `basis:default` | `asserted without basis` |

## 4. Pilot'a etkisi — düzeltilmiş tablo

İlk okumada beş `force-static` sayfasının `isr` kaydının da yanlış olduğu değerlendirilmişti. **Bu değerlendirme hatalıydı.** Next.js dokümanı açıkça diyor ki:

> Pages or layouts rendered with `force-static` can still be revalidated using `revalidate`, `revalidatePath`, or `revalidateTag`.

Bu sayfalar `gateway.ts` üzerinden `next: { revalidate: 900 }` ile veri çekiyor. Prerender + zamanlı yenileme, `isr` etiketiyle savunulabilir bir eşleşmedir. Gerçek durum:

| Route | Kayıtlı | Değerlendirme |
| --- | --- | --- |
| `/` | `isr` | **Yanlış** — `redirect("/hakkimizda")`, hiç render etmiyor |
| `/[slug]` | `isr` | **Eksik** — koşullu `notFound()` kaydedilmemiş |
| `/iletisim`, `/kariyer`, `/ekibimiz`, `/medyada-biz`, `/hakkimizda` | `isr` | **Kayıplı** — etiket savunulabilir, ama `force-static` direktifi kayıttan düşmüş |
| `/api/pages/aboutus/insertcomment`, `/api/customer-services/v2/subscribes` | `dynamic-ssr` | **Doğru** — kendi dosyalarında `cache: 'no-store'` var |
| delege edilen `/api/pages/*`, `/api/customer-services/*` | — | **Yok** — envanterde hiç görünmüyor |

Yani dokuz kayıttan **biri yanlış, biri eksik, beşi kayıplı, ikisi doğru**; ayrıca iki delege namespace envanter dışında.

## 5. Düzeltmenin gerektirdikleri

Bütüncül çözümde uygulanacak beş kural:

1. **Kontrol akışı, rendering'den önce gelir.** `redirect()` veya `notFound()` içeren bir sayfa için önce bu davranış kaydedilir; rendering modu ikincil bir alandır.
2. **Sayfanın kendi route segment direktifi otoriterdir.** `force-dynamic` / `force-static` / `export const revalidate` bir yardımcı modül sinyaliyle ezilemez; direktif kayıtta kendi alanında saklanır.
3. **`detectRendering` yalnız route dosyalarına uygulanır.** Yardımcı modüllerden yalnız `cacheBehavior`, `dataSources` ve `clientBoundary` gibi olgular toplanır; rendering modu değil.
4. **Erişilebilirlik, katkı demek değildir.** Bir modülün sinyali route'u etkileyecekse, sayfanın veri yolunda olduğu gösterilmeli; yalnız import closure'ında bulunması yetmez (RCE-005'in geniş evidence sorunuyla aynı kök).
5. **Yokluktan türetme `basis: "default"` taşır** (RCE-007).

Ek olarak `next.config` `rewrites()`/`redirects()` ayrı bir delegation kaydı üretmelidir (K5).

## 6. Bağımlılıklar

- **RCE-007** — K6'nın çözümü orada tanımlandı; bu paket onu test edilebilir kılıyor (vaka G).
- **RCE-005** — kural 4, geniş evidence sorununun aynı köküne dokunuyor; ikisi birlikte çözülmeli.
- **RCE-009/011** — "veri yolunda mı" sorusu ancak tipli, yönlü kenarlarla kesin cevaplanabilir.
