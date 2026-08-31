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
| `memory_repository` | Repository verilmezse liste; verilirse profil ve indexed SHA | Çok küçük |
| `memory_route` | Route verilmezse envanter; verilirse tek route davranışı/evidence | Küçük, structured |
| `memory_context` | Lookup, dependency, flow, impact, debug, plan, verification, change-review, approved decision veya indexed-SHA sorusu | En çok 8.000 karakter |

Araçların tamamı read-only'dir. `memory_context` kendi başına ikinci bir LLM çağırmaz; sorunun intent'ini deterministik olarak planlar ve çağıran Codex/Claude için kanıtlı, bütçeli bir context pack hazırlar. `answerContract` fact, derived relation, inference, uncertainty, missing evidence ve hedefli source fallback ayrımını taşır. Operasyonel `quality`, `reconcile` ve index komutları agent-facing MCP yerine CLI'da kalır.

Temporal kullanımda `atSha` tek indexed snapshot görünümünü seçer; `atSha` + `compareToSha` route/flow/config/API behavior diff üretir. Bu alanlar yalnız engine tarafından başarıyla indekslenmiş tam SHA'ları kabul eder. “Neden bunu seçtik?” soruları source code'a bakılarak cevaplanmaz; yalnız ADR/PR/issue/human-approved decision kaydı varsa `kind: decision` döner.

## 5. Kalıcı agent kuralı

`config/AGENTS.memory.example.md` içeriğini hedef repository'nin `AGENTS.md` dosyasına ekleyin. Claude için aynı prensipleri `CLAUDE.md` içinde de kullanabilirsiniz. En önemli kural:

> Exact envanter için `memory_repository`/`memory_route`; mühendislik sorusu için bir kez `memory_context`; `answerContract` kurallarını izle, belirsizlik kalırsa yalnız `answerContract.sourceFallback` dosyalarını aç. Bütün repository'yi tarama.

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
