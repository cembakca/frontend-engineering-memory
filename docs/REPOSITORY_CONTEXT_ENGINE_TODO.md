# Repository Context Engine — TODO

**Başlangıç:** 31 Ağustos 2026  
**Pilot:** `hangikredi.aboutus.fe.next`  
**North star:** Belirli bir Git snapshot'ındaki repository gerçeklerinden, verilen mühendislik görevi için minimum, güncel ve kanıtlanabilir context'i derlemek.

Bu dosya projenin kalıcı iş sırasıdır. Yeni fikirler doğrudan implementasyona alınmaz; önce buradaki ölçüm ve bağımlılık sırasına yerleştirilir.

Durumlar: `[ ]` bekliyor, `[-]` devam ediyor, `[x]` tamamlandı.

## A. Ölçüm ve ürün sözleşmesi

- [x] **RCE-001 — Evaluation contract ve golden-question kataloğu.** Pilot için görev sınıfları, 50 gerçek soru, evidence beklentileri, A/B protokolü ve başarı eşikleri tanımlandı. Çıktı: `docs/REPOSITORY_CONTEXT_ENGINE_EVALUATION.md`.
- [ ] **RCE-002 — Memory açık/kapalı A/B baseline.** Aynı model ve temiz oturumlarla ilk 15 yüksek öncelikli vakayı çalıştır; doğruluk, source fallback, açılan dosya, context/token ve latency sonuçlarını kaydet.
- [ ] **RCE-003 — Retrieval miss taksonomisi.** Her başarısızlığı `missing-fact`, `missing-relation`, `wrong-intent`, `ranking`, `stale`, `unsupported-inference`, `over-retrieval` veya `agent-policy` sınıfına ayır.
- [ ] **RCE-004 — Context ekonomi sözleşmesi.** MCP payload, source reads, tool tanımları, cache read/write ve toplam agent context'i birbirinden ayıran ölçüm formatını belirle.

## B. Bilgi kalitesi ve kanonik model

- [ ] **RCE-005 — Entity/evidence normalizasyon tasarımı.** Aynı config veya dependency için tek kanonik entity ve çoklu occurrence/evidence modeli tanımla. Pilot'taki 84 config memory / 19 benzersiz konu tekrarını kaldırmayı hedefle.
- [ ] **RCE-006 — Değer üretmeyen memory politikası.** Genel `business_capability` placeholder'larını ve generated/inactive dependency gürültüsünü retrieval'dan çıkaracak kabul kurallarını tanımla.
- [ ] **RCE-007 — Fact confidence sözleşmesi.** `observed`, `derived`, `inferred`, `human-approved` seviyelerini; hangi seviyede hangi cevap dilinin kullanılacağını ve zorunlu evidence koşullarını belirle.
- [ ] **RCE-008 — Analyzer semantic correctness paketi.** Redirect, rewrite, not-found, route delegation, cache inheritance ve runtime davranışı için source-backed doğruluk vakaları ekle. `/` redirect vakası ilk zorunlu regression testidir.

## C. Repository semantic graph

- [ ] **RCE-009 — Graph ontology.** `route`, `component`, `symbol`, `handler`, `backend-endpoint`, `config`, `package`, `test`, `capability` entity'lerini ve `renders`, `calls`, `submits-to`, `reads`, `fetches`, `inherits`, `validated-by`, `affected-by`, `implemented-by` edge'lerini tanımla.
- [ ] **RCE-010 — Symbol/component graph extraction.** Import erişilebilirliğinin ötesinde export, call, render ve form→handler bağlantılarını çıkar.
- [ ] **RCE-011 — Flow traversal.** UI→validation→captcha→route handler→upstream ve page→layout→menu/cache gibi sıralı akışları evidence ile döndür.
- [ ] **RCE-012 — Change-impact traversal.** Değişen file/symbol'den etkilenen route, component, API, config ve testlere ters graph yürüyüşü yap.
- [ ] **RCE-013 — Test/verification graph.** Test dosyası, script, lint/build komutu ve doğrulanamayan coverage boşluklarını birinci sınıf veri yap.

## D. Task-aware retrieval ve context compiler

- [ ] **RCE-014 — Görev niyeti modeli.** `lookup`, `explain-flow`, `impact`, `debug`, `implementation-plan`, `change-review`, `verify`, `unknown` sınıflarını Türkçe/İngilizce karma sorularda ayır.
- [ ] **RCE-015 — Query plan.** Exact SQL, graph traversal, FTS ve vector kanallarını göreve göre sıralayan; gerekirse ikinci retrieval turu yapan plan üret.
- [ ] **RCE-016 — Dedupe ve ranking sözleşmesi.** Kanal skorlarını doğrudan toplamak yerine kanonik entity, relation coverage, freshness, evidence quality ve task fit ile sırala.
- [ ] **RCE-017 — Context-pack şemaları.** `flow`, `impact`, `implementation`, `debug` ve `change-review` için küçük, typed ve token-budgeted çıktı formatları tanımla.
- [ ] **RCE-018 — Answer contract.** Fact, derived relation, inference, uncertainty, missing evidence ve önerilen source fallback alanlarını agent'a açıkça bildir.
- [ ] **RCE-019 — MCP yüzeyini sadeleştir.** Az sayıda stabil tool tut; çakışan çağrıları, aynı veriyi iki kez döndürmeyi ve gereksiz tool metadata maliyetini azalt. Gerekirse MCP resource/prompt yüzeylerini yalnız ölçülmüş kullanım için ekle.

## E. Temporal ve karar hafızası

- [ ] **RCE-020 — Behavior diff.** SHA değişimini dosya listesinden öte route/flow/config/API davranış farkı olarak üret.
- [ ] **RCE-021 — Point-in-time context.** Gereksinim doğrulanırsa belirli SHA'daki aktif fact/graph görünümünü sorgula.
- [ ] **RCE-022 — Decision provenance.** `why` bilgisini source code'dan tahmin etme; ADR, PR, issue veya human-approved kaynağa bağlanabilen ayrı karar modeli tasarla.
- [ ] **RCE-023 — Native agent memory sınırı.** Codex/Claude kişisel/episodic memory'si, repository talimatları ve source-truth context engine arasında sahiplik kurallarını belgeleyip tekrar üretimi engelle.

## F. Telemetry, işletim ve rollout

- [ ] **RCE-024 — Retrieval telemetry.** Tool seçimi, query planı, sonuç ID'leri, payload karakter/token tahmini, latency, fallback ve retrieval miss verisini secrets/source content toplamadan ölç.
- [ ] **RCE-025 — Answer feedback loop.** Kullanıcı/agent tarafından `sufficient`, `source-needed`, `wrong`, `stale` sinyallerini evaluation backlog'una taşı.
- [ ] **RCE-026 — Freshness SLO.** Merge→indexed SHA gecikmesi, reconciliation drift'i ve stale cevap davranışı için hedefler belirle.
- [ ] **RCE-027 — Güvenlik ve veri yönetişimi.** Secret/env value redaction, repository erişim sınırı, AI extraction verisi, retention ve audit politikasını tanımla.
- [ ] **RCE-028 — İkinci pilot kabul kapısı.** RCE-001 hedefleri tek pilotta karşılanmadan ikinci repository ekleme. İkinci pilotu yalnız farklı router/architecture çeşitliliği için seç.
- [ ] **RCE-029 — Kontrollü çoklu-repository rollout.** Ölçülen precision, freshness, context ekonomisi ve işletim maliyeti kabul edildikten sonra registry'yi kademeli büyüt.

## Şimdilik yapılmayacaklar

- Sırf daha fazla memory üretmek için bütün source dosyalarını AI ile özetlemek.
- Evaluation kanıtı olmadan embedding modeli veya vector store değiştirmek.
- Full source chunk'larını model context'ine veya vector indeksine gelişigüzel kopyalamak.
- Source/ADR/PR kanıtı olmadan `why` veya business rule uydurmak.
- Tek pilotun task-level doğruluğu kabul edilmeden 16 repository rollout yapmak.
