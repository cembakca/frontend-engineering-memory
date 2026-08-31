# Plan Uyum ve Eksik Analizi

**Son güncelleme:** 31 Ağustos 2026  
**Karşılaştırılan hedef:** `docs/ENGINEERING_MEMORY_PLAN.md`  
**Pilot kapsam:** `hangikredi.aboutus.fe.next`; tek repository kullanımı performans için bilinçli bir sınırdır ve eksik sayılmaz.

## Yönetici özeti

P0, P1 ve P2 bulguları giderildi. Sistem doğrulanmış Git snapshot'ını atomik işler, temporal geçmiş ve kaynak kanıtı tutar, değişmeyen memory/vector kimliklerini korur ve SQL + FTS5 + filtreli sqlite-vec aramasını tek retrieval yüzeyinde birleştirir.

P2 ile Codex ve Claude için token-sınırlı, salt-okunur stdio MCP sunucusu; kanıt kapılı isteğe bağlı AI extraction; zamanlanmış reconciliation; kalite ölçümleri ve Recall@K evaluation eklendi. Normal sync/search hiçbir harici LLM çağrısı yapmaz. AI extraction yalnız açık komutla çalışır.

## Durum özeti

| Alan | Durum | Kanıt |
| --- | --- | --- |
| Git snapshot, atomik sync, temporal geçmiş | Tamamlandı (P0) | `src/git/git.ts`, `src/sync/sync.ts`, `src/memory/store.ts` |
| Route davranışı ve dependency ilişkileri | Tamamlandı (P0/P1) | `src/analyzers`, `route_dependencies` |
| Evidence ve değişiklik audit'i | Tamamlandı (P1) | `memory_evidence`, `index_run_changes`, `changed_since` |
| SQL + FTS5 + filtreli vector retrieval | Tamamlandı (P1) | `src/retrieval`, `src/memory/vector-store.ts` |
| Hash/embedding reuse | Tamamlandı (P1) | `src/memory/vectorize.ts`, `src/sync/sync.ts` |
| Token-sınırlı MCP | Tamamlandı (P2) | `src/mcp/server.ts`, `src/mcp/tools.ts`, `src/retrieval/context.ts` |
| Typed AI extraction | Tamamlandı (P2, isteğe bağlı) | `src/extractors/ai.ts`, `src/sync/ai-extract.ts` |
| Scheduled reconciliation | Tamamlandı (P2) | `src/sync/reconcile.ts` |
| Kalite ve retrieval evaluation | Tamamlandı (P2) | `qualityReport`, `src/retrieval/evaluate.ts`, `config/retrieval-evaluation.json` |
| Çoklu repository rollout | Pilot sonrası | Registry destekliyor; tek repo pilotu bilinçli sınır |

## P0 — giderilen doğruluk ve veri bütünlüğü bulguları

1. Analyzer, evidence ve vector hazırlığı sonrası tüm snapshot yazımları tek transaction'da yapılır.
2. Eski memory/evidence satırları `active=0` ve `removed_sha` ile temporal geçmişte korunur.
3. Branch, clean tree, beklenen full SHA ve ancestor ilişkisi doğrulanır.
4. Layout ve erişilebilir yerel import zinciri route davranışına ve evidence'a katılır.
5. App Router intercepting route segmentleri doğru normalize edilir.

## P1 — giderilen kabul ve retrieval bulguları

1. Route satırları server/client sınırları, data/backend kaynakları, cache, SEO ve middleware sinyallerini taşır.
2. Fetch/Axios/ky/GraphQL/custom client, env/config ve internal package kullanımları structured dependency ve route edge'leri olur.
3. Change classifier ilgili analyzer/impact graph yolunu seçer; ilgisiz değişiklik embedding üretmez.
4. Typed deterministic memory çeşitleri ve doğrudan source evidence üretilir.
5. `index_run_changes` üzerinden bir SHA'dan sonraki CREATE/DEACTIVATE değişimleri sorgulanır.
6. Exact sorular SQL'e, teknik terimler FTS'e, kavramsal sorular filtreli vector KNN'e yönlenir.
7. `source_hash` eşleşmesinde memory ID, evidence ve vector yeniden kullanılır.

## P2 — giderilen agent, AI ve kalite bulguları

### MCP ve token ekonomisi

Salt-okunur MCP yüzeyi exact repository/route envanteri için iki araç ve dependency, değişiklik, flow, impact, debug, plan, verification veya açık uçlu sorular için tek `memory_context` sağlar. Context compiler varsayılan karakter bütçesi içinde intent-specific evidence pack ve fact/relation/inference kullanımını sınırlayan `answerContract` üretir. Böylece agent önce merkezi memory'den seçici bağlam alır, yalnız belirsizlik kaldığında `answerContract.sourceFallback` dosyalarını açar. Operasyonel kalite ölçümü CLI'da kalır.

### Evidence-gated AI extraction

AI provider bir HTTP arayüzünün arkasındadır ve yalnız `business_capability`/`business_rule` üretebilir. Confidence eşiği, dosya, satır aralığı ve birebir source quote doğrulanmadan kayıt yazılmaz. AI memory'leri `producer=ai` ve kalite skoru taşır; evidence hash'i değişince pasifleştirilir. Bu yol explicit `ai-extract` komutudur; normal indeksleme maliyet oluşturmaz.

### Reconciliation ve evaluation

`reconcile`, `reconcile-all` ve sunucuya bağlı isteğe bağlı scheduler aynı Git/hash-aware sync yolunu kullanır. `quality` evidence/commit/line/symbol/vector kapsamasını verir. Checked-in evaluation seti kanal ve beklenen sonuçları Recall@K ile denetler. Next.js custom `distDir` build output'u analizden çıkarıldığı için derlenmiş kopyalar arama sonuçlarını kirletmez.

## Pilot doğrulaması

- Pilot source taraması: 75 dosya
- Aktif inventory: 9 route, 31 dependency, 112 route-dependency, 175 memory
- Aynı SHA'da ikinci reconciliation: `0 created / 175 reused / 0 deactivated`
- Evidence coverage: `%100`; commit coverage: `%100`
- Vector completeness: `175/175` (`%100`)
- Evaluation: `3/3` vaka başarılı, `Recall@K = 1.0`, üç beklenen sonuç da 1. sırada
- Typecheck, build ve 20 otomatik test başarılı

Line coverage `%86.29`, symbol coverage `%30.86` ölçülmüştür. Her deterministic bulgu için satır/symbol üretmek anlamlı olmadığı için bunlar görünür kalite metrikleridir; evidence ve commit kapsaması gibi zor kabul eşiği değildir.

## POC kabul soruları

Next.js sürümü/router türü, aktif route listesi, route source/rendering davranışı, cookies/headers kullanımı, backend/config/internal-package bağımlılıkları, middleware kapsamı, son merge memory değişiklikleri ve kaynak kanıtları SQL/FTS/vector/MCP yüzeylerinden yanıtlanabilir.

## Pilot sonrası geliştirme alanları

Bunlar kapanmamış P2 hatası değil, gerçek kullanımdan veri geldikçe yapılacak production hardening işleridir:

1. Codex/Claude gerçek sorularından evaluation setini büyütmek.
2. Araç bazında latency, hit-rate ve dönen context/token telemetrisi eklemek.
3. Gereksinim oluşursa SHA/zaman bazlı point-in-time sorgu yüzeyi eklemek.
4. Pilot precision kabulünden sonra kontrollü çoklu-repository rollout yapmak.
5. Yalnız yerel stdio yetersiz kalırsa kimlik doğrulamalı remote MCP taşımak.
