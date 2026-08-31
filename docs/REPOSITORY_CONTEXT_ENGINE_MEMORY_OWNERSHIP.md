# RCE-023 — Native agent memory sınırı

Tek bir bilginin üç ayrı memory katmanında kopyalanması stale ve çelişkili cevap üretir. Sahiplik bu nedenle sınıf başına tektir.

| Memory sınıfı | Tek owner | Örnek |
| --- | --- | --- |
| Personal preference | Codex/Claude native memory | Kullanıcının tercih ettiği cevap biçimi |
| Episodic task state | Codex/Claude task/thread | Bu görevde hangi adımda kalındığı |
| Workflow policy | Repository instructions | Önce `memory_context` çağırma kuralı |
| Repository fact | Context engine | Route rendering, config kullanımı |
| Semantic relation | Context engine | Flow/impact graph edge'i |
| Human decision | Context engine decision store | Approved ADR rationale'ı |

Kurallar [`config/memory-ownership.json`](../config/memory-ownership.json) içinde makine-okunur, `src/memory/ownership.ts` içinde executable mapping olarak bulunur.

Tekrar üretimi engelleyen sınırlar:

1. Native agent memory repository fact/graph/decision payload'ını kopyalamaz; yalnız repository ve MCP pointer'ını hatırlayabilir.
2. `AGENTS.md`/`CLAUDE.md` facts yazmaz; nasıl retrieve edileceğini söyler.
3. Context engine kişisel tercih, thread özeti veya workflow policy saklamaz.
4. Why bilgisi normal fact extraction'dan üretilemez; yalnız RCE-022 ingest yolundan gelir.

Bu sınır erişim kontrolü değildir; veri sahipliği ve deduplication sözleşmesidir. Secret redaction, retention ve repository authorization RCE-027 kapsamındadır.
