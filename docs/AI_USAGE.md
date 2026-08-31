# Codex ve Claude ile Token-Ekonomik Kullanım

Bu sistemin ana çalışma biçimi **memory-first retrieval**'dır. SQLite/vector veritabanı modele bütünüyle yüklenmez. Agent önce küçük bir MCP aracı çağırır; varsayılan semantic context 5 sonuç ve yaklaşık 8.000 karakterle sınırlıdır. Source code yalnız dönen evidence dosyaları üzerinden gerektiğinde açılır.

## 1. Hazırla ve güncel tut

```bash
cd "/Users/cembakca/Downloads/Archive 3/frontend-engineering-memory"
pnpm install
npm run build
npm run memory -- full hangikredi.aboutus.fe.next
```

Main merge sonrasında en ucuz güncelleme incremental sync'tir:

```bash
npm run memory -- sync hangikredi.aboutus.fe.next
```

Servis açıkken saatlik hash-aware reconciliation çalıştırmak için:

```bash
MEMORY_RECONCILE_INTERVAL_MINUTES=60 npm run serve
```

Reconciliation değişmeyen memory ve vector'leri yeniden üretmez. CI mümkünse her main merge'inde `/sync` endpoint'ini tam commit SHA ile tetiklemelidir; scheduler kaçırılmış drift için emniyet ağıdır.

## 2. Codex'e bağla

Önce build alın. Ardından bir kez:

```bash
codex mcp add frontend-memory \
  --env MEMORY_DB_PATH="/Users/cembakca/Downloads/Archive 3/frontend-engineering-memory/data/engineering-memory.sqlite" \
  --env MEMORY_REPOSITORIES_FILE="/Users/cembakca/Downloads/Archive 3/frontend-engineering-memory/config/repositories.json" \
  --env MEMORY_EMBEDDINGS_ENABLED=1 \
  -- node "/Users/cembakca/Downloads/Archive 3/frontend-engineering-memory/dist/mcp/server.js"
```

Kontrol:

```bash
codex mcp list
```

Codex uygulaması/CLI/IDE extension yeniden başlatıldığında aynı yerel MCP konfigürasyonunu kullanır. Alternatif proje config örneği `config/codex-mcp.example.toml` içindedir.

## 3. Claude Code'a bağla

Kullanıcı seviyesinde bir kez:

```bash
claude mcp add frontend-memory --scope user \
  --env MEMORY_DB_PATH="/Users/cembakca/Downloads/Archive 3/frontend-engineering-memory/data/engineering-memory.sqlite" \
  --env MEMORY_REPOSITORIES_FILE="/Users/cembakca/Downloads/Archive 3/frontend-engineering-memory/config/repositories.json" \
  --env MEMORY_EMBEDDINGS_ENABLED=1 \
  -- node "/Users/cembakca/Downloads/Archive 3/frontend-engineering-memory/dist/mcp/server.js"
```

Kontrol:

```bash
claude mcp list
```

Paylaşılan proje konfigürasyonu gerekiyorsa `config/claude-mcp.example.json` örneğini hedef repository'de `.mcp.json` olarak uyarlayın.

## 4. MCP araçları

| Araç | Ne zaman kullanılmalı | Varsayılan context maliyeti |
| --- | --- | --- |
| `memory_list_repositories` | Repository adı/SHA bilinmiyorsa | Çok küçük |
| `memory_get_repository` | Sürüm, router, güncellik | Çok küçük |
| `memory_list_routes` | Kesin route listesi | Küçük, structured |
| `memory_get_route` | Tek route davranışı/evidence | Küçük |
| `memory_dependencies` | API, env, package veya route dependency | Sınırlı liste |
| `memory_search` | Açık uçlu teknik soru | 5 sonuç / 8.000 karakter |
| `memory_changed_since` | Merge etkisi | 10.000 karakter bütçeli |
| `memory_explain` | Cevap üretmek için grounded context pack | 5 sonuç / 8.000 karakter |
| `memory_quality` | Coverage ve vector tamlığı | Çok küçük |

Araçların tamamı read-only'dir. `memory_explain` kendi başına ikinci bir LLM çağırmaz; çağıran Codex/Claude için kanıtlı küçük bir context pack hazırlar.

## 5. Kalıcı agent kuralı

`config/AGENTS.memory.example.md` içeriğini hedef repository'nin `AGENTS.md` dosyasına ekleyin. Claude için aynı prensipleri `CLAUDE.md` içinde de kullanabilirsiniz. En önemli kural:

> Önce exact MCP aracı, sonra gerekirse `memory_search(limit=5)`, en son yalnız evidence dosyaları. Bütün repository'yi tarama.

## 6. AI extraction neden ayrı?

Normal `full`, `sync`, MCP search ve vector retrieval hiçbir harici LLM çağrısı yapmaz. Business meaning enrichment istenirse açıkça:

```bash
MEMORY_AI_EXTRACTOR_URL=http://127.0.0.1:8080/extract \
npm run memory -- ai-extract hangikredi.aboutus.fe.next --file=src/app/page.tsx
```

Endpoint JSON body alır ve `{ "memories": [...] }` döndürür. Kayıt yalnız şu kapıları geçerse yazılır:

- Tür `business_capability` veya `business_rule` olmalı.
- Confidence varsayılan olarak en az `0.8` olmalı.
- Evidence dosyası istenen source ile aynı olmalı.
- Satır aralığı geçerli olmalı.
- Evidence quote belirtilen satırlarda birebir bulunmalı.

AI memory `producer=ai`, `confidence=inferred` ve numeric `quality_score` ile saklanır. Source hash değişirse pasifleştirilir. Bu akış isteğe bağlıdır; token tasarrufunun temel yolu değildir.

## 7. Kaliteyi ölç

```bash
npm run memory -- quality hangikredi.aboutus.fe.next
npm run memory -- evaluate
```

`quality`, evidence/commit/symbol/line/vector coverage verir. `evaluate`, `config/retrieval-evaluation.json` içindeki sorular için Recall@K ölçer. Yeni gerçek kullanım soruları bu evaluation setine eklenmelidir.
