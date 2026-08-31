# RCE-007 — Fact confidence sözleşmesi

**Tarih:** 31 Ağustos 2026  
**Baseline:** `pnpm memory quality hangikredi.aboutus.fe.next` → `confidenceLevels`, `distinctConfidenceLevels`  
**Durum:** sözleşme tanımlandı — uygulama analyzer katmanında yapılacak

## 1. Ölçüm: confidence alanı bugün hiçbir şey söylemiyor

| Metrik | Değer |
| --- | --- |
| `confidenceLevels` | `{ "verified": 175 }` |
| `distinctConfidenceLevels` | **1** |
| `producer` dağılımı | `deterministic`: 175 |
| `quality_score` dolu kayıt | **0 / 175** |

Şema dört ayrı alan taşıyor (`confidence`, `producer`, `quality_score`, `updated_sha`) ama depolanan 175 kaydın tamamı `verified` / `deterministic`. Tek değerli bir kolon bilgi taşımaz.

**Dahası, bu tek değer agent'a hiç ulaşmıyor.** `buildAgentContext` pack item'ları `id, repository, type, subject, fact, sourceFile, commitSha, channels, evidence` alanlarını döndürüyor — `confidence` yok. `memory_get_route` de `rendering: "isr"` döndürüyor, hiçbir güven niteleyicisi olmadan.

## 2. Kanıt: `/` route'u neden `verified` olamaz

RCE-002'nin strict regresyon vakası olan `/` route'unun depolanmış `evidence_json`'u:

```json
[
  "src/app/page.tsx: App Router page without detected dynamic trigger",
  "src/lib/menu.ts: revalidate",
  "src/lib/gateway.ts: revalidate"
]
```

Üç satır, üç ayrı sorun:

1. **İlk satır kanıt değil, kanıt yokluğudur.** "Dynamic trigger tespit edilmedi" cümlesi bir gözlem değil; analyzer hiçbir şey görmediği için varsayılana düşmüştür. Varsayılan ISR olarak kaydedilmiştir.
2. **İkinci ve üçüncü satırlar başka dosyalardan gelir.** `revalidate: 900`, `page.tsx`'te değil, layout/import closure'ı üzerinden ulaşılan `menu.ts` ve `gateway.ts`'tedir.
3. **Buna rağmen kayıt `verified` etiketlidir** ve MCP çıktısında yalnız `rendering: "isr"` görünür.

Dosyanın tamamı ise şudur:

```tsx
export default function Page() {
  redirect("/hakkimizda");
}
```

Yani sistem, *yokluktan türetilmiş bir varsayılanı*, *başka dosyalardan toplanmış kanıtla* destekleyip *doğrulanmış gerçek* olarak sunuyor. Sözleşmenin çözmesi gereken tam olarak budur — ve bu bir analyzer hatası olmanın ötesinde bir **etiketleme** hatasıdır.

## 3. Dört seviye

| Seviye | Tanım | Zorunlu evidence | Cevap dili |
| --- | --- | --- | --- |
| `observed` | İddia, kendi evidence dosyasındaki bir token/AST düğümünün doğrudan okunmasıdır | Kendi dosyasında `start_line`–`end_line`; aralık alıntılandığında iddia yeniden kurulabilmeli | **Kesin:** "`insertcomment/route.ts:80` `cache: 'no-store'` kullanıyor." |
| `derived` | İddia, observed fact'lerin adlandırılmış deterministik bir kuralının çıktısıdır | Kural kimliği + bütün girdi fact id'leri; her girdi kendisi `observed` olmalı | **Atıflı:** "Analiz, `page.tsx`'te dynamic trigger bulunmaması ve `gateway.ts`'te `revalidate: 900` olmasından ISR türetiyor." |
| `inferred` | Heuristik, istatistik veya LLM çıktısı; tam türetme yok | Evidence + `quality_score` + `producer` | **Çekinceli:** "Muhtemelen X; kanıtlanmadı — doğrulamak için `<dosya>`'yı aç." |
| `human-approved` | Bir kişi veya yazılı bir artefakt iddia ediyor; source kanıtlayamaz | ADR yolu / PR URL / issue id + onaylayan + tarih | **Kaynak atıflı:** "`ADR-014`'e göre (2026-06, <rol>), ..." |

Kayıt yoksa beşinci bir durum vardır ve o da bir cevaptır:

| Durum | Cevap dili |
| --- | --- |
| kayıt yok | **Çekinme:** "Bu kayıtlı değil; source okuması gerekiyor." |

### 3.1 Yokluktan türetme ayrı işaretlenir

`derived` seviyesinin girdisi bir sinyalin **yokluğu** ise, kayıt ek olarak `basis: "default"` taşımak zorundadır ve cevap dili varsayılan olduğunu söylemelidir:

> "`page.tsx`'te dynamic trigger **tespit edilmedi**; varsayılan olarak ISR sınıflandırıldı. Runtime davranışı için dosyayı aç."

Bu tek kural `/` vakasında agent'ı doğru davranışa iter: varsayılan bir sınıflandırma, kesin bir gerçek gibi aktarılamaz.

### 3.2 Cross-file evidence, kendi dosyası gibi sunulamaz

Bir iddia kendi dosyası dışından kanıt kullanıyorsa, o kanıt `derived` girdisidir ve **kaynağı ayrı gösterilmelidir**. `/` route'unun `revalidate` kanıtı `menu.ts` ve `gateway.ts`'ten geliyorsa, çıktı bunu `page.tsx`'in özelliğiymiş gibi göstermemelidir.

## 4. Mevcut 13 tipin seviye ataması

| Bugünkü tip | Kayıt | Yeni seviye | Gerekçe |
| --- | ---: | --- | --- |
| `cache` | 4 | `observed` | `cache: 'no-store'` / `revalidate: 900` doğrudan okunuyor |
| `security` | 2 | `observed` | header adı ve satırı |
| `technical_debt` | 1 | `observed` | TODO metni alıntılanıyor |
| `seo` | 7 | `observed` | `metadata` export'u vs `generateMetadata` doğrudan görülüyor |
| `api_dependency` | 6 | `observed` | fetch çağrısı gözlem; **çözülmüş hedef URL `derived` olur** (RCE-010) |
| `configuration` (source) | 18 | `observed` | `process.env.X` erişimi |
| `build` (Dockerfile/tsconfig) | 5 | `observed` | base image ve ayar adları okunuyor |
| `repository_profile` | 1 | `observed` | `package.json`'dan okunuyor |
| `rendering` (route) | **10** | **`derived`** | Sınıflandırma kuralı; `/` dahil ikisi `basis: "default"` |
| `configuration` (`.env`) | 66 | occurrence | RCE-005; fact değil |
| `dependency`, `design_system`, `business_capability`, `performance_observation` | 54 | reddedilir | RCE-006 |
| `inferred` | 0 | — | AI extraction kapalı |
| `human-approved` | 0 | — | ADR/PR kaynağı yok |

Sonuç: bugün `verified` etiketli 175 kaydın, temizlik sonrası kalan 74'ünün **64'ü `observed`, 10'u `derived`.** En sonuç doğuran kayıt (`/` → ISR) `derived` + `default`'tur ve bugün olduğu gibi kesin sunulamaz.

`human-approved` seviyesinin kaynağı bu sürümde **yok**. RCE-N07 ("Ekip neden Next.js 16'yı seçti?") bu yüzden çekinme ile cevaplanmak zorundadır; seviye RCE-022 ile beslenecektir.

## 5. Zorunlu koşullar

1. **Seviye, üretim anında atanır.** Analyzer varsayılan olarak `observed` yazamaz; kuralın türü seviyeyi belirler.
2. **`observed`, kendi dosyası dışında evidence taşıyamaz.** Taşıyorsa `derived`'dır.
3. **`derived`, kural kimliği olmadan yazılamaz.** Kural adı sabit bir sözlükten gelir (`route-rendering-classification`, `layout-cache-inheritance`, `constant-resolution`, …) ki bir kural yanlış çıktığında etkilenen bütün fact'ler tek sorguyla bulunabilsin.
4. **`inferred`, `quality_score` ve `producer` olmadan yazılamaz.** Bugünkü AI extraction sınırı korunur.
5. **Seviye düşürülebilir, yükseltilemez.** Bir `derived` fact'in girdilerinden biri geçersizleşirse fact `derived` kalır veya deaktive edilir; hiçbir koşulda `observed`'a yükselmez.

## 6. Payload'a ne zaman eklenmeli

`confidence` alanı bugün pack'e **eklenmemelidir.** 175 kaydın tamamı `verified` olduğu için alanı şimdi açmak, agent'a sahte güvence üretir — hepsi doğrulanmış gibi görünür, oysa `/` vakası tam tersini kanıtlıyor.

Sıra şudur:

1. Analyzer seviyeleri gerçekten atasın (bu madde).
2. `quality` raporunda `distinctConfidenceLevels > 1` olsun — doğrulama sinyali budur.
3. Ancak o zaman `confidence`, `basis` ve `derivedFrom` alanları MCP pack'ine eklensin (**RCE-018**).

Bu sıra bozulursa sistem, ölçülmemiş bir güveni ölçülmüş gibi gösterir; RCE-002'de agent'ı yanlış cevaba götüren mekanizmanın aynısı, bu kez alan adıyla meşrulaştırılmış olur.

## 7. Bağımlılıklar

- **RCE-008** — `/` regresyonunun kendisi. Confidence sözleşmesi yanlış sınıflandırmayı doğru yapmaz; yalnız yanlış sunulmasını engeller. İkisi birlikte gerekir.
- **RCE-010** — `INSERT_COMMENT_URL` gibi sabitlerin çözülmesi `derived` üretir; bugün `api_dependency` çözülmemiş sabiti `observed` gibi sunuyor.
- **RCE-018** — cevap sözleşmesi bu seviyeleri okuyacak; alan adları burada sabitlenmiştir.
- **RCE-022** — `human-approved` seviyesinin tek meşru kaynağı.
