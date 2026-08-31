# Frontend Engineering Memory — Ürün ve Teknik Plan

Bu belge, birden fazla Next.js repository'si için merkezi ve artımlı güncellenen bir **Frontend Engineering Memory** sisteminin hedefini tanımlar. Uygulama ayrıntıları değişebilir; aşağıdaki ilkeler, veri modeli ve kabul ölçütleri ürünün kanonik yönüdür.

## 1. Amaç ve değişmez ilkeler

Sistem, başlangıçta 16 Next.js repository'sinin teknik gerçeklerini merkezi bir hafızada tutacaktır. Repository'lerin içine üretilmiş memory dosyaları yazılmayacaktır.

İki ilke değişmezdir:

1. Çalışan source code gerçeklik kaynağıdır.
2. Kaynakta doğrulanamayan bilgi uydurulmaz.

Her teknik iddia kaynak dosya, mümkünse sembol ve satır aralığı, dosya hash'i ve Git SHA ile izlenebilir olmalıdır.

## 2. Hedef mimari

```text
                    16 Next.js Repository
                             |
                       main'e merge
                             |
                             v
                    Memory Sync Trigger
                             |
                    last SHA <-> new SHA
                             |
                             v
                      git diff analizi
                             |
              +--------------+--------------+
              |                             |
              v                             v
      deterministic analyzer         AI extraction layer
              |                             |
              +--------------+--------------+
                             |
                             v
                     Structured Memory
                             |
             +---------------+----------------+
             |               |                |
             v               v                v
           SQLite           FTS5          Vector Index
                                               |
                                  @huggingface/transformers
                                               |
                                  +------------+------------+
                                  |                         |
                                  v                         v
                              AI Agents                  MCP / API
                       Cursor / Codex / vb.
```

SQLite'ın tek writer'ı merkezi Memory Service olacaktır. CI job'ları aynı SQLite dosyasını doğrudan açmayacaktır.

## 3. Merkezi proje yapısı

Hedef dizin ayrımı aşağıdaki sorumlulukları görünür kılmalıdır:

```text
frontend-engineering-memory/
├── src/
│   ├── analyzers/
│   │   ├── repository-profile.ts
│   │   ├── routes.ts
│   │   ├── rendering.ts
│   │   ├── dependencies.ts
│   │   ├── api.ts
│   │   ├── authentication.ts
│   │   ├── cache.ts
│   │   ├── middleware.ts
│   │   └── seo.ts
│   ├── extractors/
│   │   ├── deterministic/
│   │   └── ai/
│   ├── memory/
│   │   ├── database.ts
│   │   ├── store.ts
│   │   ├── embeddings.ts
│   │   ├── vector-search.ts
│   │   ├── full-text-search.ts
│   │   └── retrieval.ts
│   ├── git/
│   │   ├── diff.ts
│   │   └── change-impact.ts
│   ├── sync/
│   │   ├── full-index.ts
│   │   └── incremental-index.ts
│   ├── api/
│   └── mcp/
├── data/
│   └── engineering-memory.sqlite
└── config/
    └── repositories.json
```

Fiziksel dosya adları birebir aynı olmak zorunda değildir; sorumlulukların ayrıştırılması esastır.

## 4. Repository registry

`config/repositories.json`, kapsamdaki 16 repository için en az şu bilgileri tanımlar:

- Benzersiz repository adı
- Checkout yolu
- Ana branch (`main` veya gerektiğinde `master`)
- Merkezi servisin checkout'u yönetip yönetmediği
- Gerekliyse Git remote adı

## 5. İlk çalışma: Full Index

Bir repository ilk kez eklendiğinde tam tarama yapılır:

- Framework ve sürümler
- Router türü
- Routes
- Rendering
- API ve data fetching
- Cache
- Authentication
- Middleware
- Dependencies ve internal packages
- SEO ve analytics
- State management ve error handling
- Configuration
- Build/runtime
- Kaynaktan doğrulanabilen business capability/rule ve technical debt

Başarılı işlem sonunda `last_indexed_sha` ve `last_indexed_at` kaydedilir. Başarısız bir işlem kısmi yeni durumu görünür hâle getirmemelidir.

## 6. Main merge sonrası incremental update

Her senkronizasyonda veritabanındaki `last_indexed_sha` ile repository'nin yeni ana branch HEAD'i karşılaştırılır:

```text
git diff --name-status <last_indexed_sha>..<new_head_sha>
```

Yalnızca değişen veya değişiklikten etkilenen alanlar yeniden analiz edilir. Eklenen, değişen, silinen ve yeniden adlandırılan dosyalar ayrı ayrı ele alınır. Memory açısından ilgisiz bir değişiklikte LLM veya embedding çalıştırılmaz.

### Route istisnası

Route discovery ucuz ve doğruluk açısından kritiktir. Bu yüzden her senkronizasyonda `app/`, `src/app/`, `pages/` ve `src/pages/` route ağacı tam olarak yeniden taranır:

```text
main merge
   |-- full route scan       (her zaman)
   `-- incremental analysis  (değişen/etkilenen kod)
```

## 7. Route birinci sınıf veridir

Route bilgileri generic memory metni olarak değil, ayrı `routes` tablosunda tutulur. Bir route kaydı hedef olarak şunları taşır:

- `repository_id`
- `route_pattern`, `route_type`, `router_type`
- `source_file`, `layout_chain`
- `rendering_mode`
- `dynamic_route`, `route_params`
- `auth_required`
- `server_component`, `client_boundaries`
- `data_sources`, `backend_dependencies`
- `middleware_matched`
- `cache_behavior`
- `seo_type`, `metadata_source`
- `created_sha`, `last_seen_sha`, `removed_sha`, `active`

Tam route listesi gibi kesin sorular doğrudan SQL ile yanıtlanır; semantic search kullanılmaz.

## 8. Next.js route discovery kapsamı

Sistem Next.js 12–16 aralığındaki Pages Router, App Router ve hybrid projeleri desteklemelidir.

Desteklenecek yapılar:

- `pages/index.tsx`, nested pages ve `pages/api/*`
- `app/**/page.tsx` ve `app/**/route.ts`
- `[slug]`, `[...slug]`, `[[...slug]]`
- URL'ye girmeyen route group'lar: `(public)`
- Parallel routes: `@slot`
- Intercepting routes: `(.)`, `(..)`, `(..)(..)`, `(...)`
- Pages Router özel dosyaları ile App Router özel konvansiyonlarının doğru ayrımı

Route'un yalnızca varlığı değil; rendering, auth, middleware, cache, SEO ve backend bağımlılık davranışı da kayda alınmalıdır. Bu davranış yalnız route dosyasından değil, layout ve import edilen bileşen/servis zincirinden de gelebilir.

## 9. Typed memory

Tek bir büyük metin yerine aşağıdaki typed memory sınıfları kullanılır:

| Memory type | İçerik |
| --- | --- |
| `repository_profile` | Framework, Next/React/Node, router, package manager |
| `rendering` | SSR, RSC, static/dynamic davranış |
| `api_dependency` | Backend/API bağlantıları |
| `data_fetching` | fetch, Axios, server/browser data flow |
| `cache` | Next, React Query ve custom cache |
| `authentication` | Token, session ve cookie davranışı |
| `middleware` | Matcher, rewrite, redirect ve auth |
| `state_management` | Redux, Zustand, Context vb. |
| `design_system` | Internal UI paketleri |
| `shared_package` | Şirket içi npm paketleri |
| `seo` | Metadata, canonical, robots |
| `analytics` | Analytics mimarisi |
| `error_handling` | 404/500 ve error boundary |
| `configuration` | Önemli env/config anahtarları |
| `build` | Docker, build ve runtime |
| `dependency` | Mimari açıdan önemli paketler |
| `security` | Kaynaktan doğrulanan güvenlik mimarisi |
| `performance_observation` | Kaynakta görülen performans pattern'leri |
| `business_capability` | Repository'nin yaptığı işler |
| `business_rule` | Kodla doğrulanan iş kuralları |
| `technical_debt` | Doğrulanmış teknik borç |

İlk kapsam dışında kalan konular:

- Feature Flag / A-B Testing
- Observability
- Incoming Consumers
- Cross-Repository Analysis

## 10. Kalıcı veri modeli

İlk sürümün çekirdek tabloları:

- `repositories`: kimlik, profil, branch ve son başarılı SHA
- `index_runs`: FULL/INCREMENTAL işlem geçmişi ve değişiklik sayaçları
- `routes`: aktif/pasif route envanteri ve davranış alanları
- `memories`: typed, confidence'lı ve yaşam döngülü teknik gerçekler
- `memory_evidence`: dosya, sembol, satır ve hash kanıtı
- `dependencies`: paket/API/config bağımlılıkları
- `route_dependencies`: route ile dependency arasındaki kullanım ilişkileri
- `memory_fts`: FTS5 indeksi
- Vector store: memory embedding'leri

Memory ve route geçmişi hard delete yerine `active`, `removed_sha` ve zaman/SHA alanlarıyla korunmalıdır.

## 11. Embedding ve vector abstraction

Embedding, `memories.content` kaydından ayrı tutulur. `EmbeddingProvider` ve `VectorStore` arayüzleri uygulamanın geri kalanını belirli bir model veya veritabanı eklentisine bağlamamalıdır.

İlk uygulama için:

- `@huggingface/transformers` ile local feature extraction
- `sqlite-vec` ile SQLite yanında vector index

`sqlite-vec` pre-v1 olduğundan ileride pgvector veya başka bir store'a geçiş, analyzer ve retrieval katmanlarını değiştirmeden yapılabilmelidir.

## 12. Deterministic ve AI analyzer ayrımı

### Deterministic analyzer

LLM gerektirmeden çıkarılabilecek bilgiler:

- Next, React ve Node sürümü
- App/Pages/Hybrid Router
- Routes ve route params
- `"use client"`, `cookies()`, `headers()`
- `getServerSideProps`, `getStaticProps`
- `revalidate`, `dynamic`, fetch cache ayarları
- Middleware matcher
- Environment anahtarları
- npm/internal packages, imports ve layouts
- Route handlers

TypeScript compiler API veya `ts-morph` tabanlı AST kullanımı tercih edilir.

### AI analyzer

Yorum gerektiren alanlarla sınırlandırılır:

- Bir route veya API'nin business amacı
- Kodla doğrulanabilen business rule yorumu
- Mimari açıdan önemli implementation özeti
- Değişikliğin hangi mevcut memory'leri etkilediği

AI çıktısı typed bir şemadan geçmeli, confidence ve source evidence olmadan veritabanına yazılamamalıdır.

## 13. Source evidence ve yaşam döngüsü

Her memory şu kanıt zincirine sahip olmalıdır:

```text
memory
  -> repository
  -> source file
  -> symbol / line range (varsa)
  -> file hash
  -> indexed commit SHA
```

Kanıt dosyası değiştiğinde ilgili aktif memory'ler bulunur, eski kayıtlar pasifleştirilir, güncel kaynak yeniden analiz edilir ve yalnız değişen memory'lerin embedding'i üretilir.

Silinen route veya memory tamamen yok edilmez:

```text
active = false
removed_sha = <new_head_sha>
```

Bu sayede “hangi route ne zaman kaldırıldı?” ve “bu bilgi hangi SHA'da değişti?” soruları yanıtlanabilir.

## 14. Change classifier ve dependency impact

Changed file, ilgili analyzer'lara yönlendirilir:

| Değişiklik | Analyzer |
| --- | --- |
| `package.json`, lockfile | Repository profile + dependency |
| `next.config.*` | Configuration + routing + build |
| `middleware.*` | Middleware + authentication |
| `app/**/page.*` | Route + rendering |
| `app/**/layout.*` | Layout + rendering + etkilenen routes |
| `pages/**/*` | Route + rendering |
| `services/**`, API clients | API + data fetching |
| `queries/**` | React Query/cache |
| `providers/**` | Architecture/state/auth |
| SEO dosyaları | SEO |
| Docker/build dosyaları | Build/runtime |
| Env/config kullanımı | Configuration |

Sadece değişen dosyayı taramak yeterli değildir. Import/dependency graph, örneğin bir servisten Header'a, root layout'a ve tüm route'lara yayılan etkileri bulmalıdır. Graph üzerinde route-to-dependency, layout inheritance ve cache invalidation ilişkileri tutulur.

## 15. Periyodik full reconciliation

Incremental algoritmadaki olası drift'i gidermek için periyodik bir full reconciliation çalışır. Güncel kaynak ile kayıtlı memory karşılaştırılır; `source_hash` değişmemişse memory ve embedding yeniden üretilmez.

## 16. Retrieval

Soru türüne göre üç kanal kullanılır:

```text
              QUESTION
                  |
       +----------+----------+
       |          |          |
       v          v          v
      SQL        FTS5       Vector
       |          |          |
       +----------+----------+
                  |
                  v
                Rank
                  |
                  v
             Agent Context
```

- SQL: sürüm, repository profili, route envanteri ve kesin filtreler
- FTS5: token, paket, API ve framework terimleri
- Vector: farklı ifadelerle sorulan kavramsal sorular
- Hybrid rank: yalnız ilgili ve sınırlı context'in agent'a verilmesi

Agent context'i repository, typed memory, evidence ve commit bilgisini içermeli; 16 repository'nin tamamını gelişigüzel yüklememelidir.

## 17. API, MCP ve CI

Merkezi HTTP API en az repository bilgisi, routes, search, full index ve sync işlemlerini sunar. CI, main merge sonrasında repository kimliği ve hedef commit ile bu servisi tetikler.

İkinci entegrasyon katmanı MCP'dir. Hedef araçlar:

- `memory.get_repository`
- `memory.list_routes`
- `memory.get_route`
- `memory.search`
- `memory.dependencies`
- `memory.changed_since`
- `memory.explain`

Cursor, Codex ve diğer agent'lar bu araçlarla memory'ye erişir.

## 18. Uçtan uca işlem

```text
Developer -> merge to main -> CI -> Memory Sync API
                                      |
                              get last indexed SHA
                                      |
                                   git diff
                                      |
                    +-----------------+-----------------+
                    |                                   |
              route rescan                       changed files
                    |                                   |
                    |                           classify changes
                    |                                   |
                    |                         deterministic scan
                    |                                   |
                    |                      AI extraction if needed
                    +-----------------+-----------------+
                                      |
                              reconcile memories
                            INSERT / UPDATE / DEACTIVATE
                                      |
                           regenerate changed embeddings
                                      |
                              atomic transaction
                                      |
                              last_indexed_sha
                                      |
                                     DONE
```

## 19. Fazlar

| Faz | İçerik | Amaç |
| --- | --- | --- |
| Phase 1 | SQLite, repo registry, full scan, routes | Temeli doğrulamak |
| Phase 2 | Incremental Git diff sync | Main merge güncellemesi |
| Phase 3 | Rendering/API/auth/cache analyzer | Gerçek teknik memory |
| Phase 4 | FTS5 | Exact engineering search |
| Phase 5 | Embeddings + vector search | Semantic search |
| Phase 6 | Hybrid retrieval | SQL + FTS + vector |
| Phase 7 | MCP | Agent entegrasyonu |
| Phase 8 | CI integration | 16 repo otomatik sync |
| Phase 9 | Dependency graph / impact analysis | Değişiklik etkisi |

Embedding, memory kalitesi doğrulandıktan sonra devreye alınmalıdır. Kötü memory'nin iyi embed edilmesi ürün kalitesini artırmaz.

## 20. İlk POC kapsamı ve kabul ölçütleri

POC, biri App Router ağırlıklı ve biri Pages Router/legacy olan iki farklı Next.js repository'siyle doğrulanır.

İlk POC'nin doğru üretmesi gerekenler:

- Repository profile
- Routes
- Rendering
- API dependencies
- Middleware
- Authentication
- Cache
- Important packages
- Source evidence
- Git SHA
- Incremental update

Başarı için aşağıdaki soruların kaynak kanıtlı doğru yanıtlanması gerekir:

1. Bu repository hangi Next.js sürümünde?
2. App Router mı, Pages Router mı, hybrid mi?
3. Tüm aktif route'ları getir.
4. `/x` route'u hangi dosyada?
5. `/x` nasıl render ediliyor ve neden?
6. Hangi route'larda `cookies()` veya `headers()` kullanılıyor?
7. Hangi backend API'leri çağrılıyor?
8. Middleware ne yapıyor ve hangi route'ları kapsıyor?
9. Son main merge'i hangi memory kayıtlarını değiştirdi?
10. Bu cevapların source-code kanıtları nerede?
