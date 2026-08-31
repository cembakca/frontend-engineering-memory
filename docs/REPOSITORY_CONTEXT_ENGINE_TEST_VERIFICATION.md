# RCE-013 — Test/verification graph

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/analyzers/verification-graph.ts`](../src/analyzers/verification-graph.ts)  
**Test:** [`test/verification-graph.test.ts`](../test/verification-graph.test.ts) — 6 vaka  
**Durum:** test vakaları, verification komutları ve coverage boşlukları birinci sınıf veri

## 1. Üç ayrı gerçek

“Nasıl doğrularım?” sorusu tek bir dosya listesinden cevaplanamaz. Analyzer üç şeyi ayrı tutar:

| Veri | Kimlik | Anlamı |
| --- | --- | --- |
| Test vakası | `<test file>#<suite > case>` | Çalıştırılabilir somut vaka |
| Verification komutu | `script:<name>` | `test`, `typecheck`, `lint` veya `build` package script'i |
| Coverage boşluğu | gap kind + opsiyonel target | Neyin doğrulanamadığı ve neden |

Bir `build` veya `lint` script'inin bulunması test coverage değildir. Aynı şekilde dosya adında “test” geçmesi test runner kanıtı değildir.

## 2. `validated-by` çıkarımı

Test/spec dosyaları TypeScript AST ile okunur. `describe` başlıkları vaka kimliğine katılır; `test`/`it` callback'i içinde gerçekten kullanılan production import'ları hedef olur:

```text
src/lib/contact.ts#validateContactForm
  validated-by → test/contact.test.ts#contact > rejects empty name
```

Bir production import'u test dosyasının tepesinde bulunuyor ama ilgili vaka içinde kullanılmıyorsa o vaka için kenar üretilmez. Route handler export'u test edildiğinde hem symbol hem route identity'sine `validated-by` yazılır. Bilinen bir route string'i doğrudan test vakasında kullanılırsa route kenarı ayrıca kurulabilir.

Her kenar test dosyasını, test çağrısının satırını, tam vaka başlığını ve `observed` confidence'ı taşır.

Desteklenen test dosyası biçimleri:

```text
**/*.test.{ts,tsx,js,jsx,mts,cts}
**/*.spec.{ts,tsx,js,jsx,mts,cts}
**/__tests__/*.{ts,tsx,js,jsx,mts,cts}
```

Framework sınıflandırması `node:test`, Vitest, Jest ve Playwright import'larından yapılır. Bilinmeyen runner `unknown` olarak korunur; uydurulmaz.

## 3. Verification komutları

`package.json#scripts` içinden dört sınıf çıkarılır:

- `test`: adı `test`/`test:*` olan veya gerçek Jest, Vitest, Playwright, Cypress, `node --test` ya da `tsx --test` çağrısı yapan script
- `typecheck`: `typecheck`/`type-check` veya `tsc --noEmit`
- `lint`: `lint:*` veya ESLint çağrısı
- `build`: `build`/`build:*`

Her komut package dosyası ve satır kanıtı taşır. `dev`, `start` ve `clean` script'leri verification envanterine girmez.

## 4. Coverage boşlukları

```ts
type VerificationGapKind =
  | "missing-test-command"
  | "missing-test-files"
  | "unvalidated-target";
```

Caller kritik route/symbol/component hedeflerini verir. Hiçbir `validated-by` kenarı hedefe ulaşmıyorsa target identity ve kind ile açık gap üretilir. Böylece “test bulamadım” boş sonuç değil, sorgulanabilir bir sonuçtur.

Bu model testin gerçekten başarılı olduğunu iddia etmez. Komutun son çalışma durumu runtime telemetry konusudur; burada yalnız repository snapshot'ında bulunan doğrulama yüzeyi çıkarılır.

## 5. Pilot — D07

`hangikredi.aboutus.fe.next` snapshot'ında ölçülen sonuç:

| Metrik | Sonuç |
| --- | ---: |
| Test/spec dosyası | **0** |
| Test runner script'i | **0** |
| `validated-by` kenarı | **0** |
| Build komutu | **5** (`build` ve ortam varyantları) |
| Lint komutu | **1** |
| Typecheck komutu | **0** |
| Doğrulanmamış route | **9 / 9** |

Bu, RCE-D07'nin “automated test stratejisi yok; yalnız lint/build var” beklentisini doğrudan kanıtlıyor. Özellikle:

- `.env.test` bir ortam dosyasıdır, test suite değildir.
- `Dockerfile.test` bir image build tanımıdır, test suite değildir.
- `build:test` test ortamı için build alır; test runner çalıştırmaz ve `build` sınıfında kalır.

## 6. Açık sınırlar

- Dynamic test üretimi ve string olmayan test başlıkları vaka kimliğine dönüştürülmez.
- Barrel üzerinden test import'u şu anda barrel symbol'ünde kalabilir; production symbol graph'taki re-export çözümünün ortaklaştırılması sonraki iyileştirmedir.
- CI dosyalarındaki command zincirleri bu maddede çıkarılmıyor; package script'leri kanonik çalıştırma yüzeyi kabul edildi.
- RCE-017 `verify` context pack'i bu graph'ın command, test ve gap alanlarını bütçeli biçimde sunacaktır.
