# RCE-004 — Context ekonomi sözleşmesi

**Tarih:** 31 Ağustos 2026  
**Ölçüm:** `pnpm memory context-economy --policy=../hangikredi.aboutus.fe.next/AGENTS.md`  
**Uygulama:** [`src/retrieval/context-economy.ts`](../src/retrieval/context-economy.ts)  
**Ham çıktı:** `eval-results/rce-004-economy-1.json`

## 1. Neden ayrıştırma gerekiyor

"Memory %84 tasarruf sağlıyor" cümlesi ölçüm değil. Beş ayrı kalem tek sayıya karıştığı için:

- Oturum daha ilk soru sorulmadan bir sabit maliyet ödüyor.
- Pack küçük olabilir ama yanlışsa source okumasını **değiştirmiyor**, üstüne ekleniyor.
- Karakter sayısı model token'ı değil; ikisi asla aynı satırda raporlanmamalı.
- Cache read/write yalnız client'ın bildiği bir şey; motor bunu tahmin edemez.

Bu sözleşme beş kalemi ayırır ve hangisinin kim tarafından ölçüleceğini bağlar.

## 2. Beş kalemli defter

| # | Kalem | Kim ölçer | Birim | Durum |
| --- | --- | --- | --- | --- |
| 1 | **Sabit oturum maliyeti** — tool tanımları + server instructions + repository policy bloğu | Engine (`context-economy`) | karakter → token tahmini | ✅ ölçülüyor |
| 2 | **Değişken MCP payload** — tool çağrısı başına dönen JSON | Engine (`context-eval`) | karakter → token tahmini | ✅ ölçülüyor |
| 3 | **Source reads** — agent'ın açtığı dosyalar (baseline seti + pack yetersizse fallback) | Engine (baseline) + client (gerçek fallback) | dosya sayısı ve byte | ⚠️ baseline ölçülüyor, gerçek fallback client'tan gelir |
| 4 | **Cache read/write** | Yalnız client | billed token | ❌ engine tahmin etmez, `null` bırakır |
| 5 | **Toplam agent context** | Yalnız client (`/context`, `/usage`) | billed token | ❌ engine tahmin etmez, `null` bırakır |

**Kural:** 1–3 arası kalemler `chars/3.5` tahminidir ve **tahmin olarak etiketlenir**. 4–5 gerçek fatura token'ıdır. Bir rapor bu iki grubu asla aynı toplamda birleştirmez.

## 3. Ölçülen sabit oturum maliyeti

Hiçbir soru sorulmadan, MCP sunucusu bağlıyken ödenen:

| Kalem | Karakter | ~Token | Pay |
| --- | ---: | ---: | ---: |
| Tool tanımları (9 tool) | 5.378 | **1.537** | %77 |
| Server instructions | 350 | 100 | %5 |
| `AGENTS.md` memory policy bloğu | 1.262 | 361 | %18 |
| **Toplam** | **6.990** | **1.998** | %100 |

En pahalı üç tool tanımı: `memory_search` 303, `memory_explain` 204, `memory_changed_since` 196 token.

**Client'a bağlı önemli fark:** şema ertelemesi yapan client'larda (Claude Code tool search) oturum başta yalnız tool **isimlerini** yükler — 51 token. Şema ancak tool gerçekten çağrılacağı zaman getirilir. Yani sabit maliyet client'a göre **1.998 ile 512 token arasında** değişiyor. Bu nedenle her ölçüm kaydı client adını ve yükleme modunu içermek zorundadır; aksi halde iki koşu karşılaştırılamaz.

### Doğrudan çıkan bulgu

Sabit maliyetin %21'i gereksiz yüzey:

- `memory_explain` (204 token) `memory_search` ile **aynı kodu** çağırıyor — `tools.explain` yalnızca `limit` ve `maxChars` varsayılanı koyup `tools.search`'e devrediyor. `AGENTS.md` zaten "ikisini aynı soruyla çağırma" demek zorunda kalmış; bu, yüzeyin kendisinin fazla olduğunun itirafı.
- `memory_quality` (124 token) bir operasyon aracı; görev context'i derlemeye katkısı yok.

İkisinin kaldırılması sabit maliyeti 328 token düşürür ve agent'ın iki özdeş aracı ayırt etme yükünü kaldırır. → **RCE-019.**

## 4. Değişken maliyet — iki senaryo

Payload büyüklüğü tek başına ekonomiyi belirlemiyor. Belirleyen, pack'in source okumasının **yerine geçip geçmediği**.

| Senaryo | Varsayım | 15 soruda toplam | Soru başına medyan |
| --- | --- | ---: | ---: |
| **Nominal** | Pack source okumasını tamamen değiştiriyor | **+62.830 token** | +3.645 |
| **Etkin** | Yalnız temiz vakada değiştiriyor; başarısız vakada agent hem pack'i hem source'u ödüyor | **−7.431 token** | −883 |

RCE-003 ölçümüne göre 15 vakanın yalnız **4'ü temiz**. Sabit 1.998 token da eklendiğinde etkin sonuç **15 soruda −9.429 token** — yani motor bu haliyle net **kaybettiriyor**.

Nominal break-even 0,55 soru/oturum: pack doğru olsaydı sabit maliyet ilk sorudan önce amorti olurdu. Doğru olmadığı için bu eşiğe hiç ulaşılmıyor.

**Sözleşmenin merkezi cümlesi: context ekonomisi doğruluğun türevidir.** Payload küçültmek bir kazanç üretmez; yalnız doğru pack kazanç üretir. Bu nedenle bundan sonraki hiçbir ekonomi raporu task correctness'ten ayrı sunulmaz.

### Motorun kaybettiği vakalar birinci sınıf metrik

Nominal senaryoda bile üç vakada motor source okumaktan pahalı:

| Vaka | Nominal | Neden |
| --- | ---: | --- |
| RCE-F06 | −1.287 | `memory_get_route` + `memory_search`, üç dosya okumaktan pahalı |
| RCE-D07 | −227 | İki tool çağrısı, sıfır ilgili fact |
| RCE-E03 | −60 | Tek satırlık dosya için 8 dependency + layout chain dökümü |

`negativeCases` sayısı bundan sonra medyan tasarrufun yanında **zorunlu** olarak raporlanır. Medyan tek başına, motorun küçük sorularda kaybettiğini gizler.

## 5. Kayıt formatı

`context-economy` komutu aşağıdaki yapıyı üretir. Client'ın bildiği alanlar `null` gelir ve **elle doldurulur**; engine bunları asla tahmin etmez.

```jsonc
{
  "sourceRun": "eval-results/rce-002-run-1.json",
  "targetSha": "...",
  "charsPerToken": 3.5,
  "fixedSessionCost": {
    "toolDefinitions": { "tools": 9, "chars": 5378, "tokens": 1537,
                         "perTool": [...],
                         "deferredNameOnly": { "chars": 177, "tokens": 51 } },
    "serverInstructions": { "chars": 350, "tokens": 100 },
    "repositoryPolicy":   { "file": "...AGENTS.md", "chars": 1262, "tokens": 361 },
    "totalTokens": 1998,
    "complete": true
  },
  "variableCost": {
    "cases": 15, "cleanCases": 4,
    "nominal":   { "total": 62830, "median": 3645, "negativeCases": ["RCE-E03","RCE-D07","RCE-F06"] },
    "effective": { "total": -7431, "median": -883 },
    "perCase": [ { "caseId": "...", "clean": true,
                   "engineTokens": 0, "baselineTokens": 0,
                   "nominalSaving": 0, "effectiveSaving": 0 } ]
  },
  "breakEven": { "nominalQuestionsPerSession": 0.55 },
  "clientReported": {
    "totalContextTokens": null,   // Claude Code /context
    "cacheReadTokens":    null,   // /usage
    "cacheWriteTokens":   null,
    "outputTokens":       null
  }
}
```

Her koşuya ayrıca şu üç alan elle eklenir, çünkü rakamlar bunlar olmadan karşılaştırılamaz:

```text
client:            claude-code 2.x | codex | other
tool_loading_mode: eager | deferred
model:             claude-opus-5 | ...
```

## 6. Kabul eşikleri

Bundan sonraki koşular şu eşiklere göre değerlendirilir:

| Metrik | Eşik | Şu an |
| --- | --- | --- |
| Etkin medyan tasarruf | > 0 token | **−883** ❌ |
| Motorun kaybettiği vaka | ≤ %10 | %20 (3/15) ❌ |
| Sabit oturum maliyeti (eager client) | ≤ 1.500 token | 1.998 ❌ |
| Nominal medyan tasarruf | ≥ %40 baseline | %84,4 ✅ |
| Karakter tahmini ile billed token'ın karıştırılması | 0 rapor | 0 ✅ |

Etkin tasarruf pozitife dönmeden nominal tasarruf **başarı olarak sunulmaz.**

## 7. Sonraki maddelere devir

- **RCE-005** — `duplicate retrieval` metriği bugün hesaplanamıyor: aynı gerçek hem route SQL satırı hem `rendering` memory'si olarak dönüyor ve iki kez sayılıyor. Kanonik entity olmadan bu kalem defterde açık kalır.
- **RCE-006** — pack'te dönen değersiz kayıtlar hem token hem `limit: 5` penceresinde slot harcıyor; ekonomik etkisi bu defterde `over-retrieval` üzerinden izlenecek.
- **RCE-019** — `memory_explain` ve `memory_quality`'nin kaldırılması ölçülmüş 328 token sabit kazanç sağlar.
- **RCE-024** — telemetry, bu defterin alan adlarını birebir kullanır; yeni bir şema üretilmez.
