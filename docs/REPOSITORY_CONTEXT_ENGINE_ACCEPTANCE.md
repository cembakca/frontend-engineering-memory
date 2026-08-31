# RCE-006 — Değer üretmeyen memory politikası

**Tarih:** 31 Ağustos 2026  
**Makine-okunur kurallar:** [`config/memory-acceptance.json`](../config/memory-acceptance.json)  
**Durum:** politika tanımlandı — uygulama extraction katmanında yapılacak

## 1. Ölçüm

175 aktif memory, içeriklerindeki dosya yolu, satır numarası ve paket adı maskelendiğinde **94 benzersiz şablona** iniyor. Kayıtların 108'i (%62) en az iki kayıtlı bir şablon grubunda.

Ama şablon tekrarı tek başına suç değil. `src/lib/gateway.ts defines a revalidate value of 900 seconds` ile `src/lib/agreements.ts defines a revalidate value of 900 seconds` aynı şablonu paylaşır ve **ikisi de değerlidir** — dosyayı okumadan bilinemezler. Ayrım şu sorudadır:

> İçerik, dosya yolundan ve zaten yapısal tabloda duran bilgiden türetilebiliyor mu?

## 2. Değer üretmeyen dört grup

### 2.1 `business_capability` — 9 kayıt, sıfır bilgi

Dokuz kaydın tamamı, dosya yolu dışında **birebir aynı**:

```text
src/app/kariyer/page.tsx exposes a user-facing page or route-handler capability;
no unverified business purpose is inferred.
```

`src/analyzers/source-memory.ts:202` bir path regex'i eşleşince bu sabit cümleyi yazıyor. Cümlenin taşıdığı tek bilgi — "bu bir page/route handler" — zaten `routes` tablosunda, üstelik rendering, cache ve layout chain ile birlikte. Retrieval açısından bu dokuz kayıt yalnız `limit: 5` penceresinde yer kaplıyor.

### 2.2 `performance_observation` — 11 kaydın 10'u false positive

Onu şunu diyor: `contains performance-related pattern performance import react.`

Kök neden `src/analyzers/source-facts.ts:109`:

```ts
if (/^(next\/dynamic|react)$/.test(value))
  pushUnique(facts.performanceSignals, located(source,node,`performance import ${value}`));
```

Kural `next/dynamic` (code splitting) için yazılmış, ama `react`'i de yakalıyor. **Her düz React import'u performance gözlemi oluyor.** React import etmek bir client component'in tanımı gereğidir; gözlem değil, taban özelliğidir. Yalnız `useCallback()` kaydı gerçek sinyal.

### 2.3 `dependency` memory'leri — 31 kayıt, tablonun birebir kopyası

`memories(dependency)` = 31, `dependencies` tablosu = 31. Tam 1:1:

```text
@tailwindcss/postcss is recorded as npm dependency (styling) for Styling infrastructure.
```

Memory, yapısal satırın taşımadığı hiçbir şey söylemiyor. Var olma nedeni meşru — satırın FTS/vector'de aranabilir olması. Ama çözüm satırı kopyalamak değil, **entity'yi indekslemek** (RCE-005).

### 2.4 `design_system` — 3 kayıt

`src/app/layout.tsx imports internal package @hangikredi/tokens` — `dependencies(internal-package)` satırının yeniden ifadesi. Aynı gerekçe.

## 3. Beş kabul kuralı

| Kural | Test | Verdict |
| --- | --- | --- |
| **R1 — path-derivable** | İçerikten dosya yolu maskelendiğinde kalan, o tipin bütün kayıtlarında aynı sabit ise | reddet |
| **R2 — model-redundant** | Yapısal bir tablo aynı `(subject, source)` çiftini eşit veya daha yüksek hassasiyetle tutuyorsa | reddet, yapısal satırı indeksle |
| **R3 — saturated-signal** | Pattern kaynaklı bir memory'nin sinyali, uygun dosyaların %50'sinden fazlasında ateşleniyorsa | kuralı daralt |
| **R4 — occurrence-not-fact** | İki memory yalnız evidence konumuyla ayrılıyorsa | **silme, normalize et** (RCE-005) |
| **R5 — quotable-evidence** | İddia kendi evidence dosyasındaki belirli bir satır aralığına karşı doğrulanamıyorsa | reddet |

R4 ayrımı kritik: `.env` config kayıtlarını silmek occurrence bilgisini kaybettirir. Onlar reddedilmez, tek entity'nin occurrence'larına dönüşür.

R5 bugün yalnız AI üretimi memory'lere uygulanıyor (`docs/ARCHITECTURE.md`, AI extraction boundary). Deterministik memory'lere de genişletilir; `business_capability` bu testten geçemez çünkü doğrulanacak bir iddia içermiyor.

## 4. Uygulama noktası

**Extraction time birincil, retrieval time yedek.**

Extraction'da reddetmek DB'yi, FTS indeksini ve vector indeksini birlikte küçültür. Retrieval'da filtrelemek yalnız pencereyi korur, depolama ve embedding maliyetini korumaz. Ancak henüz yeniden indekslenmemiş repository'ler için retrieval tarafında bir guard gerekir; bu guard `config/memory-acceptance.json` içindeki `verdicts` tablosunu okur.

## 5. Beklenen sonuç

| Grup | Kayıt | İşlem |
| --- | ---: | --- |
| Reddedilen | **54** | `business_capability` 9, `performance_observation` 10, `dependency` 31, `design_system` 3, `build`/next.config.ts 1 |
| Normalize edilen | **66** | `.env` configuration → 19 entity + occurrence (RCE-005) |
| Korunan | **55** | rendering, seo, api_dependency, cache, security, technical_debt, build (Dockerfile/tsconfig), configuration (source), repository_profile, performance (useCallback) |

Sonuç: **175 → 74 kanonik fact (%58 azalma)**, hiçbir gerçek bilgi kaybı olmadan. `duplicationRatio` hedefi 0,3886 → ≤ 0,05.

Retrieval etkisi: RCE-003'te dokuz vakada işaretlenen `over-retrieval` uyarısının doğrudan kaynağı bu 54 kayıt. `RCE-P03` ve `RCE-D01` paketlerinde ilk sıralara gelen `performance_observation` kayıtları buradan geliyordu.

## 6. TODO'nun "generated/inactive dependency gürültüsü" maddesi — ölçüm sonucu temiz

Bu madde açılırken varsayılan sorun **doğrulanmadı**:

| Kontrol | Sonuç |
| --- | ---: |
| Aktif memory'lerde generated (`aboutus/`, `node_modules/`, `.next/`) evidence | **0** |
| `memory_fts` satırı vs aktif memory | 175 / 175 — sızıntı yok |
| Pasif memory'lerde generated evidence | 634 |
| Pasif memory sayısı (hepsinde `removed_sha` dolu) | 859 |

`distDir` dışlaması çalışıyor; 634 generated evidence satırı, dışlama eklenmeden önceki bir indeks koşusundan kalan ve düzgün deaktive edilmiş kayıtlara ait. Retrieval'a sızmıyorlar.

Geriye kalan tek soru **retention**: 859 pasif memory ve evidence'ı DB'de süresiz duruyor. Bu bir retrieval sorunu değil, saklama politikası sorunu → **RCE-027**.

## 7. Silinmemesi gereken bir şey

`build` tipindeki `Dockerfile.test defines container build/runtime with base images node:22.23.2-alpine...` kaydı, önceki oturumda `RCE-D07` (test stratejisi) sorusunda agent'ı yanlış yöne çeken kayıttı. Ama kayıt **doğru ve değerlidir** — Dockerfile gerçekten var ve base image'ları isimlendiriyor.

Yanlış cevabın nedeni bu kaydın varlığı değil, **doğru cevabın yokluğu**: projede test framework'ü, test script'i ve `error.tsx` olmadığını söyleyen bir fact yok. Boşluğu gürültü siliyormuş gibi kapatmak yanlış olur; çözüm RCE-013'ün test/verification fact tipidir.

Bu, politikanın genel ilkesi: **değer üretmeyen kaydı sil, ama eksik fact'i silmeyle çözmeye çalışma.**
