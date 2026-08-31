# RCE-019 — Sadeleştirilmiş MCP yüzeyi

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/mcp/server.ts`](../src/mcp/server.ts), [`src/retrieval/task-context.ts`](../src/retrieval/task-context.ts)  
**Test:** [`test/mcp.test.ts`](../test/mcp.test.ts)  
**Durum:** agent-facing yüzey 9 tool'dan 3 stabil tool'a indirildi

## 1. Yeni sözleşme

| Tool | Mod | Sonuç |
| --- | --- | --- |
| `memory_repository` | `repository` yok / var | repository listesi / exact profil ve indexed SHA |
| `memory_route` | `route` yok / var | active route envanteri / exact route, evidence ve dependencies |
| `memory_context` | mühendislik sorusu | intent-aware, evidence-bearing ve karakter bütçeli context pack |

`memory_context` soruyu RCE-014 intent modeli ve RCE-015 query planıyla işler. Lookup/unknown sorgular bounded ranked fact listesine; flow, impact, implementation, debug ve change-review sorguları RCE-017'nin discriminated pack şemalarına gider. `verify` intent'i implementation pack içindeki verification yüzeyini kullanır. `since` yalnız change-review için verilebilir. RCE-020/021 ile `atSha` point-in-time, `atSha` + `compareToSha` behavior diff seçer; RCE-022 açık why/rationale sorularını approved decision store'a yönlendirir.

Araçların üçü de `readOnlyHint`, `idempotentHint` ve `openWorldHint: false` taşır. Hata cevapları MCP `isError` olarak döner.

## 2. Kaldırılan çakışmalar

Eski agent-facing adlar artık kayıt edilmez:

- Liste/get çiftleri `memory_repository` ve `memory_route` içinde optional selector ile birleşti.
- `memory_search`, `memory_explain`, `memory_dependencies` ve `memory_changed_since` tek `memory_context` girişinde intent/query-plan ile birleşti.
- `memory_quality` operasyonel olduğu için MCP'den çıkarıldı; CLI `quality` komutu değişmedi.

`MemoryTools` içindeki düşük seviye yardımcılar şimdilik HTTP/CLI ve geçiş ihtiyaçları için korunuyor; MCP discovery'de görünmüyor. `config/context-engine-eval.json` içindeki eski tool planları ve RCE-002 sonuçları tarihsel baseline'ı yeniden üretebilmek için bilerek değiştirilmedi.

## 3. Ölçülen metadata maliyeti

`context-economy` MCP client'ın gördüğü `tools/list` tanımlarını JSON serialize ederek aynı `chars/3.5` tahminiyle ölçtü:

| Yüzey | Tool | Şema karakteri | ~Token | Deferred isim ~token |
| --- | ---: | ---: | ---: | ---: |
| RCE-004 baseline | 9 | 5.378 | 1.537 | 51 |
| RCE-019 | 3 | 2.107 | 602 | 14 |
| RCE-023 güncel | 3 | 2.241 | 641 | 14 |
| Güncel vs baseline | −6 | −3.137 | **−896 (%58,3)** | **−37 (%72,5)** |

RCE-019 tamamlandığında server instructions 345 karakter/~99 tokendı. Temporal ve decision kullanımını aynı uzunlukta daha yoğun ifade eden güncel talimat da 345 karakter/~99 tokendır; şema + instructions toplamı ~740 tokendır. Repository policy maliyeti repository'ye bağlı olduğundan bu sayıya eklenmemiştir.

En büyük güncel schema `memory_context`'tir (1.221 karakter/~349 token); temporal iki SHA alanı eklenmesine rağmen toplam yüzey baseline'ın %58,3 altındadır.

## 4. Neden resource veya prompt eklenmedi?

RCE-019 yalnız ölçülmüş kullanım için resource/prompt eklenmesini şart koşuyordu. Mevcut baseline exact inventory ile task context dışında tekrar kullanılan statik bir payload göstermiyor. Yeni resource veya prompt hem discovery metadata'sı hem seçim belirsizliği ekleyeceği için bu aşamada yüzey üç tool ile sınırlı tutuldu.

## 5. Agent çağrı politikası

1. Repository veya route envanteri kesin olarak isteniyorsa ilgili exact tool'u çağır.
2. Diğer mühendislik sorularında `memory_context`'i bir kez, varsayılan 8.000 karakter bütçesiyle çağır.
3. Pack yeterliyse source açma; belirsizlik kalırsa yalnız `answerContract.sourceFallback` içindeki dosyaları hedefli aç.
4. Güncellik iddiasından önce `lastIndexedSha` veya `snapshotSha` değerini ilgili Git snapshot ile karşılaştır.

Bu politika [`config/AGENTS.memory.example.md`](../config/AGENTS.memory.example.md) ile server instructions içinde aynı sözleşmeyi izler; context-economy gerçek server instructions sabitini doğrudan ölçer.
