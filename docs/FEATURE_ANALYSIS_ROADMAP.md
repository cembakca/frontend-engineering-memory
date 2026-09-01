# Feature Analysis & Delivery Roadmap

Bu roadmap, mevcut Repository Context Engine'in (RCE) üzerine ürün analizi, mimari karar, test planlama, geliştirme ve teslimat hafızası ekler. Hedef yalnızca daha az token tüketmek değildir; yeni bir feature geldiğinde doğru repository'leri bulmak, kapsamı kanıtlarla çıkarmak, gereksinimleri testlere ve gerçek kod değişikliklerine kadar izlemek ve sonraki çalışmalarda bu deneyimden yararlanmaktır.

Bu belge yeni geliştirme kuyruğunun tek kaynağıdır. İş kimliği öneki `FAD` (Feature Analysis & Delivery) olarak belirlenmiştir.

## Sabit kapsam kararları

- Desteklenen ürün ailesi Next.js repository'leridir.
- Başlangıçta iki, hedefte aynı organizasyona ait yaklaşık 16 bağımsız repository vardır.
- Monorepo modellemesi kapsam dışıdır.
- OpenAPI/GraphQL schema ingest ilk aşamada kapsam dışıdır.
- Runtime instrumentation ve build-manifest kanıtı ilk aşamada kapsam dışıdır.
- MCP retrieval yüzeyi varsayılan olarak salt okunur kalır; kalıcı hafıza yazımları kontrollü import/onay hattından geçer.
- SQLite yerel ve tek-yazarlı kullanımın varsayılanıdır. PostgreSQL'e geçiş ancak ölçülen eşzamanlı yazma, erişim kontrolü veya merkezi servis ihtiyacıyla açılır.
- Embedding modeli, reranker veya vector database değişikliği yalnız feature-level evaluation anlamlı kazanç gösterirse yapılır.
- Sistem mimarın yerine nihai karar vermez. Kanıt, belirsizlik ve seçenek üretir; onay insanda kalır.

## Başarı ölçütleri

Roadmap tamamlandığında sistem aşağıdaki soruları kanıtları ve güven seviyesiyle yanıtlayabilmelidir:

1. Bu feature hangi business capability ve kullanıcı yolculuğuna aittir?
2. Hangi repository'ler etkilenir; hangileri neden elenir?
3. Her repository'de hangi route, component, symbol, config, package ve test değişebilir?
4. Mevcut ADR'ler, mimari sınırlar, business rule'lar ve NFR'ler nelerdir?
5. Eksik veya çelişkili gereksinimler nelerdir; mimara hangi sorular sorulmalıdır?
6. Kabul kriterleri hangi testlerle doğrulanacaktır?
7. Geliştirme işi repository bazında nasıl bölünmeli ve hangi sırayla yapılmalıdır?
8. PR/commit/test/release, onaylanan planı gerçekten uygulamış mıdır?
9. Benzer bir sonraki feature için hangi sonuçlar kalıcı hafızaya alınmalıdır?
10. Bu cevap, repository'leri sıfırdan tekrar taratmaya kıyasla ne kadar token ve süre kazandırmıştır?

İlk production hedefleri:

| Ölçüm | Hedef |
| --- | --- |
| Etkilenen repository recall@k | `>= 0.95` |
| Yanlış kesin repository yönlendirmesi | `<= 0.02` |
| Dosya/symbol impact recall | `>= 0.85` |
| Kabul kriteri → test izlenebilirliği | `>= 0.90` |
| Kaynaksız kritik iddia | `0` |
| Stale repository ile sessiz analiz | `0` |
| Tekrarlı feature analizinde token azalması | `>= 60%` |
| P95 feature pack üretim süresi | baseline sonrası belirlenecek |

Bu eşikler başlangıç hipotezidir; `FAD-076` ile gerçek geçmiş feature seti üzerinde kalibre edilir.

## İşletim kuralları

- `[ ]` başlanmadı, `[-]` devam ediyor, `[x]` tamamlandı, `[!]` bloke.
- Bir iş yalnız kod yazıldığı için tamamlanmaz. İlgili test, dokümantasyon, migration ve evaluation kanıtı da bitmelidir.
- Her PR başlığında en az bir `FAD-xxx` kimliği bulunmalıdır.
- Bir işin kapsamı büyürse aynı satır şişirilmez; yeni bir alt iş kimliği açılır.
- `Done` koşulu karşılanmadan sonraki fazın çıkış kapısı geçilemez.
- Her şema ve retrieval değişikliği eski SQLite verisi için migration/yeniden-index davranışını açıkça tanımlar.

## Faz 0 — Ürün sözleşmesi ve güvenli temel

Amaç: yeni katmanın sınırlarını, sahipliğini ve ölçülebilir başlangıç noktasını sabitlemek.

| Durum | İş | Bağımlılık | Teslimat | Done / kabul kriteri |
| --- | --- | --- | --- | --- |
| [ ] | **FAD-001 — Ürün charter'ı** | — | Kullanıcı rolleri, karar sınırı, hedef ve non-goal belgesi | Mimar, geliştirici, QA ve PM senaryoları örneklerle tanımlı; sistemin karar vermediği noktalar açık |
| [ ] | **FAD-002 — Uçtan uca kullanım senaryoları** | FAD-001 | Feature intake, change, bug, refactor ve production feedback akışları | En az 10 gerçek senaryo; her birinin girdisi, çıktısı ve onay noktası var |
| [ ] | **FAD-003 — Truth-plane sahiplik matrisi** | FAD-001 | Product, architecture, code ve delivery truth için source-of-truth tablosu | Her entity'nin sahibi, güncelleme yolu, freshness ve conflict kuralı tanımlı |
| [ ] | **FAD-004 — Organizasyon bağımsızlığı** | — | Sabit şirket/repository/package namespace'lerini config veya genel kurala taşıma | Kaynak, test, config ve docs içinde şirkete özel sabit değer yok; generic fixture testi geçiyor |
| [ ] | **FAD-005 — Veri sınıflandırma ve redaction politikası** | FAD-003 | Secret, PII, ticari bilgi ve telemetry kuralları | Her ingest kaynağı için allow/deny/redact davranışı testli |
| [ ] | **FAD-006 — Provenance ve güven sözleşmesi** | FAD-003 | `sourceRef`, SHA/version, observedAt, confidence, approvedBy alan standardı | Kullanıcıya sunulan her kritik iddia bir kaynağa veya açık inference etiketine bağlı |
| [ ] | **FAD-007 — Şema/migration politikası** | FAD-003 | Şema sürümü, forward migration, rollback ve reindex kuralları | Eski bir fixture DB güncel sürüme veri kaybı olmadan taşınabiliyor |
| [ ] | **FAD-008 — Mevcut kalite baseline'ı** | FAD-002 | Güncel retrieval kalitesi, latency, token ve DB boyutu raporu | Sonraki değişikliklerle kıyaslanabilecek versioned JSON rapor CI artifact'i oluyor |

### Faz 0 çıkış kapısı

- Ürün ve veri sahipliği onaylanmış olmalı.
- Kuruma özgü sabitler kaldırılmış olmalı.
- Baseline olmadan retrieval/model/schema optimizasyonuna başlanmamalı.

## Faz 1 — Product ve architecture truth veri modeli

Amaç: feature'ı yalnız serbest metin olarak değil, izlenebilir ve zaman içinde sürümlenebilir bir iş nesnesi olarak saklamak.

| Durum | İş | Bağımlılık | Teslimat | Done / kabul kriteri |
| --- | --- | --- | --- | --- |
| [ ] | **FAD-009 — Capability entity** | FAD-006, FAD-007 | Capability kimliği, adı, açıklaması, owner ve yaşam döngüsü | CRUD/import, DB migration, validation ve retrieval fixture testleri var |
| [ ] | **FAD-010 — Capability alias ve sözlük** | FAD-009 | Türkçe/İngilizce adlar, ürün dili, route terimleri, eş anlamlılar | `/hakkımızda`, `about us` ve kurum terimleri aynı capability adayına bağlanabiliyor |
| [ ] | **FAD-011 — User journey modeli** | FAD-009 | Journey, step, actor ve capability ilişkileri | Çok repository'li örnek journey graph olarak sorgulanabiliyor |
| [ ] | **FAD-012 — Work item / feature entity** | FAD-006, FAD-007 | Stable ID, source reference, özet, durum, owner, priority, tarih ve sürüm | Aynı feature'ın revizyonları birbirini ezmeden tutuluyor |
| [ ] | **FAD-013 — Requirement modeli** | FAD-012 | Functional requirement, assumption, open question ve out-of-scope tipleri | Requirement'lar feature altında sıralı, kaynaklı ve ayrı ayrı onaylanabilir |
| [ ] | **FAD-014 — Acceptance criterion modeli** | FAD-013 | Given/When/Then veya doğrulanabilir plain-text kriter | Belirsiz/ölçülemez kriter validation uyarısı üretiyor |
| [ ] | **FAD-015 — Business rule modeli** | FAD-013 | Kural, koşul, sonuç, istisna, kaynak ve owner | Çelişen veya superseded kurallar görünür; kod realization edge'i kurulabilir |
| [ ] | **FAD-016 — NFR modeli** | FAD-013 | Accessibility, security, performance, SEO, analytics, i18n ve operability | Her NFR ölçülebilir hedef veya açık `unknown` içeriyor |
| [ ] | **FAD-017 — Risk ve mitigation modeli** | FAD-013 | Olasılık, etki, sinyal, mitigation, contingency ve owner | High risk maddesi testsiz/onaysız kapatılamıyor |
| [ ] | **FAD-018 — Owner/team modeli** | FAD-003 | Team, code owner, product owner ve escalation ilişkisi | Repository/capability/work item için sorumlu bulunabiliyor; bilinmiyorsa uydurulmuyor |
| [ ] | **FAD-019 — Genel traceability edge modeli** | FAD-009–018 | Typed edge, evidence, confidence, validity interval ve author | Invalid source/target kombinasyonları schema validation ile reddediliyor |
| [ ] | **FAD-020 — Temporal revision ve supersession** | FAD-012, FAD-019 | `validFrom`, `validTo`, `supersedes`, tombstone davranışı | Herhangi bir SHA/tarih için o dönemde geçerli karar ve requirement yeniden kurulabiliyor |
| [ ] | **FAD-021 — Approval lifecycle** | FAD-012–020 | Draft, in-review, approved, rejected, superseded durum makinesi | Approved kayıt sessizce değiştirilemiyor; yeni revision ve audit kaydı gerekiyor |
| [ ] | **FAD-022 — Kontrollü JSON/Markdown import contract'ı** | FAD-009–021 | Versioned import schema, dry-run, validation ve idempotency | Aynı payload iki kez işlendiğinde duplicate üretmiyor; hata satır bazında raporlanıyor |

### Faz 1 çıkış kapısı

- Bir feature; requirement, kabul kriteri, business rule, NFR ve riskleriyle sürümlenebilmeli.
- Onaylı bilgi ile agent inference'ı veri katmanında ayrılmalı.
- Her bilgi parçasının provenance'ı ve zaman geçerliliği bulunmalı.

## Faz 2 — Capability ve repository fleet graph'ı

Amaç: repository adı verilmeden başlayan bir feature talebini doğru proje adaylarına yönlendirmek.

| Durum | İş | Bağımlılık | Teslimat | Done / kabul kriteri |
| --- | --- | --- | --- | --- |
| [ ] | **FAD-023 — Capability sinyali çıkarımı** | FAD-009, RCE index | Route, segment, component, metadata, copy key ve package sinyalleri | Extractor deterministik; her ilişki source span ve confidence taşıyor |
| [ ] | **FAD-024 — Capability ↔ repository mapping** | FAD-019, FAD-023 | Birincil/ikincil ownership, evidence ve manual override | Bir capability için ilgili tüm repository'ler ve gerekçeleri listeleniyor |
| [ ] | **FAD-025 — Capability ↔ route/symbol mapping** | FAD-023 | Route, file, component ve symbol seviyesinde realization edge'leri | Kanıt zinciri capability'den kaynak satırına kadar izlenebiliyor |
| [ ] | **FAD-026 — Cross-repository interaction edge'leri** | FAD-024 | Shared package, link/navigation, config contract ve documented handoff ilişkileri | Package dependency dışındaki en az üç interaction tipi fixture ile doğrulanmış |
| [ ] | **FAD-027 — Repository rolü ve nitelik özeti** | FAD-024 | Content/product/admin/gateway benzeri rol, router, state, forms, auth, test stack | Her repository için kısa ve kaynaklı `repository profile` üretiliyor |
| [ ] | **FAD-028 — Manual mapping ve override dosyası** | FAD-024–027 | İnsan onaylı capability/owner/interaction ekleri | Reindex override'ı silmiyor; çatışma açık raporlanıyor |
| [ ] | **FAD-029 — Mapping coverage raporu** | FAD-024–028 | Unmapped route, orphan capability, owner gap ve low-confidence raporu | CI non-regression eşiğiyle coverage düşüşünü yakalıyor |
| [ ] | **FAD-030 — İlk iki repository capability catalog'u** | FAD-023–029 | Mevcut iki proje için onaylı başlangıç kataloğu | Mimar incelemesi tamam; en az 10 gerçek feature sorusunda doğru proje bulunuyor |
| [ ] | **FAD-031 — Yeni repository bootstrap üreticisi** | FAD-027–030 | Profil taslağı, capability adayları ve review checklist | Yeni Next.js repo tek komutla draft profile/catalog üretiyor |
| [ ] | **FAD-032 — Fleet-wide freshness ve readiness görünümü** | FAD-024, mevcut sync | SHA, son index, mapping coverage, eval ve health özeti | Stale/unready repository feature analizine sessizce dahil edilmiyor |

### Faz 2 çıkış kapısı

- Repository belirtilmeden capability sorgusu yapılabilmeli.
- Aday projeler yalnız skorla değil, inclusion/exclusion kanıtlarıyla dönmeli.
- İlk iki proje insan tarafından doğrulanmış capability catalog'una sahip olmalı.

## Faz 3 — Feature analysis pipeline

Amaç: ham feature talebinden tekrar üretilebilir, kanıtlı ve token-bütçeli bir `FeatureAnalysisPack` üretmek.

| Durum | İş | Bağımlılık | Teslimat | Done / kabul kriteri |
| --- | --- | --- | --- | --- |
| [ ] | **FAD-033 — Repository'siz sorgu contract'ı** | FAD-024, FAD-032 | `memory_context` için optional repository veya eşdeğer minimal tool contract | Mevcut repository-scoped istemciler bozulmadan fleet sorgusu çalışıyor |
| [ ] | **FAD-034 — Intake normalizer** | FAD-012–017 | Ham metinden amaç, actor, scope, constraint ve terim adayları | Orijinal metin korunuyor; çıkarımlar açık etiketleniyor |
| [ ] | **FAD-035 — Belirsizlik ve soru üretimi** | FAD-034 | Contradiction, missing actor/state/error/NFR ve open-question detector | Kritik belirsizlikte sistem kesin plan üretmek yerine hedefli soru soruyor |
| [ ] | **FAD-036 — Capability candidate retrieval** | FAD-010, FAD-023, FAD-034 | FTS + graph + vector aday birleştirme | Alias, Türkçe doğal dil ve route adı varyasyonları golden sette bulunuyor |
| [ ] | **FAD-037 — Repository candidate ranking** | FAD-024–027, FAD-036 | Evidence-aware ranking, confidence ve exclusion reasons | Doğru repo recall hedefi sağlanıyor; düşük güven `unknown` olarak dönüyor |
| [ ] | **FAD-038 — Multi-repository graph expansion** | FAD-026, FAD-037 | Candidate repo'dan bağımlı/etkileşimli repo genişletme | Döngü, fan-out ve depth/token limitleri testli |
| [ ] | **FAD-039 — FeatureAnalysisPack JSON schema** | FAD-013–019 | Summary, questions, candidates, impact, constraints, risks, AC, test/change/rollout planı | Versioned schema validation; her bölüm provenance/freshness içeriyor |
| [ ] | **FAD-040 — Per-repository impact compiler** | FAD-025, FAD-038, mevcut impact engine | Route/file/symbol/config/package/test etki matrisi | Direct, transitive ve inferred etkiler ayrılıyor; kanıtsız kesinlik yok |
| [ ] | **FAD-041 — Decision ve constraint compiler** | FAD-020–021, mevcut decision memory | İlgili ADR, convention, restriction ve superseded karar özeti | Sadece geçerli/onaylı kararlar default bağlayıcı; tarihsel olanlar etiketli |
| [ ] | **FAD-042 — Risk ve NFR compiler** | FAD-016–017, FAD-040 | Code/fleet sinyallerinden risk ve NFR checklist'i | Accessibility, security, performance, SEO, analytics ve rollback değerlendirilmiş |
| [ ] | **FAD-043 — Change-plan üreticisi** | FAD-039–042 | Repo bazlı hedef, non-goal, change surface ve doğrulama planı | Plan her değişikliği en az bir requirement/AC ile ilişkilendiriyor |
| [ ] | **FAD-044 — İş parçalama ve sıralama** | FAD-043 | Task graph, bağımlılık, paralel işler, owner ve completion evidence | Cross-repo sıra ve blokajlar makinece okunabilir; sahte kesin efor yok |
| [ ] | **FAD-045 — Confidence ve abstention policy** | FAD-035–044 | Bölüm bazlı güven, evidence floor ve stop/escalate kuralları | Yetersiz kanıtta tahmin yerine eksik kaynak veya insan kararı isteniyor |
| [ ] | **FAD-046 — Freshness gate ve selective resync** | FAD-032, FAD-039 | Analiz öncesi SHA/freshness kontrolü ve hedefli sync önerisi | Stale veriden üretilen pack `ready` olamıyor |
| [ ] | **FAD-047 — Token budget ve progressive disclosure** | FAD-039–046 | Summary, standard, deep seviyeleri; bölüm ve repo bütçeleri | Bütçe aşımında kanıt önceliği korunuyor; sessiz truncation yok |
| [ ] | **FAD-048 — Deterministik export** | FAD-039 | JSON ve Markdown feature pack export'u | Aynı snapshot+input aynı sıralı çıktıyı üretir; diff review yapılabilir |

### Faz 3 çıkış kapısı

- Ham feature metninden fleet-wide aday repository ve impact pack üretilebilmeli.
- Pack, açık soruları ve dışlanan projelerin nedenlerini içermeli.
- Bir mimar yalnız pack'teki kaynak linklerinden iddiaları doğrulayabilmeli.

## Faz 4 — BRD, mimari analiz ve plan onayı

Amaç: analiz çıktısını yaşayan, onaylanabilir ve geliştirilebilir bir delivery sözleşmesine dönüştürmek.

| Durum | İş | Bağımlılık | Teslimat | Done / kabul kriteri |
| --- | --- | --- | --- | --- |
| [ ] | **FAD-049 — BRD-lite şablonu** | FAD-039 | Problem, outcome, scope, actors, rules, AC, NFR, risks ve questions yapısı | Hem insan okunur hem schema-backed; boş kritik alanlar görünür |
| [ ] | **FAD-050 — Evidence-backed analiz taslağı** | FAD-040–049 | Feature pack'ten BRD/technical analysis draft | Her code/architecture iddiasında evidence; ürün varsayımları ayrı |
| [ ] | **FAD-051 — Review ve approval workflow** | FAD-021, FAD-050 | Product, architect ve QA review state'leri | Kim, neyi, hangi revision'da onayladı audit log'da bulunuyor |
| [ ] | **FAD-052 — ADR trigger kuralları** | FAD-041, FAD-050 | Yeni dependency, sınır değişimi, shared contract, security/NFR karar sinyalleri | Trigger ya ADR işi açıyor ya gerekçeli `not required` kaydı istiyor |
| [ ] | **FAD-053 — Requirement → development task dönüşümü** | FAD-044, FAD-051 | Repository bazlı uygulanabilir işler ve Done kriteri | Her task requirement, files/symbol candidates, tests ve risk içeriyor |
| [ ] | **FAD-054 — Dependency ve delivery sequencing** | FAD-026, FAD-053 | Blocking, parallel, rollout order ve integration checkpoint'leri | İki-repo fixture'da uygulanabilir sıra doğru hesaplanıyor |
| [ ] | **FAD-055 — Efor yerine belirsizlik sınıflaması** | FAD-035, FAD-053 | Known/unknown, discovery spike ve confidence etiketi | Kanıtsız saat/gün tahmini üretilmiyor; spike çıkış kriteri var |
| [ ] | **FAD-056 — Issue tracker adapter contract'ı** | FAD-012, FAD-053 | Vendor-independent issue/work-item import-export interface | İlk sürüm dosya/JSON ile çalışır; Jira/Linear zorunlu bağımlılık değildir |
| [ ] | **FAD-057 — Plan revision ve scope history** | FAD-020, FAD-051 | Onay sonrası scope değişikliği, gerekçe ve yeniden-onay | Eski ve yeni plan diff'i kaybolmadan görülebiliyor |
| [ ] | **FAD-058 — Mimari analiz audit raporu** | FAD-049–057 | Requirement, decision, risk, task ve approval coverage raporu | Eksik bağ veya onay varsa development-ready durumu verilmiyor |

### Faz 4 çıkış kapısı

- Onaylanmış feature analizi repository bazlı task'lara dönüşebilmeli.
- Scope değişiklikleri ve mimari karar ihtiyacı izlenebilmeli.
- `development-ready` yalnız ölçülebilir hazır olma koşullarıyla verilmeli.

## Faz 5 — Test intelligence ve acceptance traceability

Amaç: testleri yalnız bulunan dosyalar olarak değil, kabul kriterlerini ve riskleri doğrulayan kanıtlar olarak modellemek.

| Durum | İş | Bağımlılık | Teslimat | Done / kabul kriteri |
| --- | --- | --- | --- | --- |
| [ ] | **FAD-059 — Acceptance criterion → test edge'i** | FAD-014, FAD-019 | `verified-by` ilişkisi, evidence ve status | Bir AC birden çok test seviyesine; test birden çok AC'ye bağlanabiliyor |
| [ ] | **FAD-060 — Mevcut test coverage eşleştirme** | FAD-025, FAD-059, mevcut test graph | Requirement/route/symbol için ilgili mevcut test adayları | Yanlış eşleşme confidence ile ayrılır; source path ve test name verilir |
| [ ] | **FAD-061 — Test gap detector** | FAD-040, FAD-059–060 | Untested AC, high-risk path ve missing negative-case raporu | Golden feature setindeki bilinen boşluklar yakalanıyor |
| [ ] | **FAD-062 — Risk-based test strategy** | FAD-017, FAD-042, FAD-061 | Risk → test objective, priority ve test level önerisi | High impact/high likelihood riskin mitigation testi olmadan plan tamamlanmıyor |
| [ ] | **FAD-063 — Test seviyesi seçici** | FAD-060–062 | Unit, component, integration, E2E, accessibility ve manual ayrımı | Her öneri neden o seviyede olduğunu ve daha ucuz alternatifi açıklıyor |
| [ ] | **FAD-064 — Test data, mock ve fixture ihtiyaçları** | FAD-043, FAD-062 | State, permission, locale, error, boundary ve fixture listesi | AC'lerdeki tüm koşullar test verisine izlenebiliyor |
| [ ] | **FAD-065 — Regression test selection** | FAD-040, FAD-060 | Değişen symbol/route/dependency'den minimum güvenli regression seti | Impact fixture'larında doğrudan ve transitive testler seçiliyor |
| [ ] | **FAD-066 — Verification run modeli** | FAD-007, FAD-059 | Command, SHA, environment, result, duration ve artifact reference | Test sonucu tam commit SHA'ya bağlı; eski run güncel kanıt sayılmıyor |
| [ ] | **FAD-067 — CI/test result import'u** | FAD-066 | JUnit/JSON veya generic normalized result import | Partial, skipped, flaky ve failed durumları korunuyor; secret redaction testli |
| [ ] | **FAD-068 — TestPlanPack ve readiness gate** | FAD-061–067 | AC coverage, risk coverage, selected tests ve manual checks | Kritik AC/risk boşluğu varken release-ready sonucu üretilemiyor |

### Faz 5 çıkış kapısı

- Her kabul kriterinin doğrulama yöntemi bulunmalı veya açık gap görünmeli.
- Test planı mevcut kod, impact graph ve risklerden türemeli.
- Test çalıştırma sonucu tam SHA ile bağlanmalı.

## Faz 6 — Development ve delivery traceability

Amaç: planlanan değişiklikle gerçekleşen kod, test ve release arasındaki zinciri kapatmak.

| Durum | İş | Bağımlılık | Teslimat | Done / kabul kriteri |
| --- | --- | --- | --- | --- |
| [ ] | **FAD-069 — Branch/commit/PR/change-set modeli** | FAD-019, FAD-053 | Delivery artifact entity ve `implements` edge'leri | PR/commit bir veya daha fazla task/requirement'a bağlanabiliyor |
| [ ] | **FAD-070 — Local Git ingest adapter'ı** | FAD-069 | Branch, commit, changed files ve message referanslarını kontrollü import | Idempotent; yalnız izin verilen repo/metadata okunuyor |
| [ ] | **FAD-071 — Planned vs actual diff** | FAD-043, FAD-069–070 | Planlanan ve değişen repo/file/symbol/test karşılaştırması | Unplanned ve missing change surface ayrı raporlanıyor |
| [ ] | **FAD-072 — Scope drift detector** | FAD-057, FAD-071 | Requirement/task kapsamı dışı değişiklik uyarısı | Generated/lockfile gibi noise configurable; gerekçeli override var |
| [ ] | **FAD-073 — ADR/constraint conformance check** | FAD-041, FAD-071 | Gerçek diff'in geçerli kararlara uygunluk raporu | İhlal kanıtı source/diff referansı taşır; belirsizlik insan review'ına gider |
| [ ] | **FAD-074 — Acceptance completion matrix** | FAD-059, FAD-066, FAD-069 | AC → implementation → test run zinciri | Link veya güncel başarılı verification yoksa AC `verified` olamaz |
| [ ] | **FAD-075 — Change review pack** | FAD-071–074 | Reviewer için scope, risk, decision, diff ve test özeti | Pack token-budgeted; kritik sapmalar özetin üstünde yer alıyor |
| [ ] | **FAD-076 — Release/deployment modeli** | FAD-069 | Release ID, environment, revision, included change sets ve zaman | Hangi requirement'ın hangi release ile çıktığı sorgulanabiliyor |
| [ ] | **FAD-077 — Rollout/rollback readiness** | FAD-042, FAD-068, FAD-076 | Rollout order, checks, rollback signal ve responsible owner | Yüksek riskte rollback yolu/onayı yoksa release-ready değil |
| [ ] | **FAD-078 — Incident/feedback bağlantısı** | FAD-012, FAD-076 | Incident, bug, support feedback → requirement/release/test gap edge'i | Production bulgusu ilgili plan ve teste geri bağlanabiliyor |
| [ ] | **FAD-079 — Planned-vs-actual öğrenme kaydı** | FAD-071–078 | Yanlış repo tahmini, kaçan impact, gereksiz test ve yeni pattern kaydı | Onaylı öğrenme capability/retrieval/eval setine kontrollü aday oluyor |

### Faz 6 çıkış kapısı

- Feature'dan release'e iki yönlü traceability bulunmalı.
- Scope drift, eksik test ve ADR uyumsuzluğu review öncesi görülebilmeli.
- Production feedback sonraki feature analizini ölçülebilir biçimde beslemeli.

## Faz 7 — Agent, MCP ve kullanıcı deneyimi

Amaç: Codex, Claude ve Cursor'un aynı doğrulanmış hafızayı küçük ve kararlı bir araç yüzeyiyle kullanmasını sağlamak.

| Durum | İş | Bağımlılık | Teslimat | Done / kabul kriteri |
| --- | --- | --- | --- | --- |
| [ ] | **FAD-080 — Minimal MCP contract tasarımı** | FAD-033, FAD-039 | Mevcut tool genişletme vs tek `memory_feature` aracı kararı ve schema | Tool sayısı gerekçesiz büyümüyor; eski istemci uyumluluk testi var |
| [ ] | **FAD-081 — Salt-okunur retrieval sınırı** | FAD-080 | MCP'nin okuyabildiği ve yazamadığı işlemlerin enforcement'ı | MCP üzerinden approval/decision/work-item mutasyonu yapılamıyor |
| [ ] | **FAD-082 — Kontrollü write CLI/API** | FAD-022, FAD-081 | Import, validate, approve, supersede ve dry-run komutları | Her mutation audit/provenance taşır; destructive işlem açık onay ister |
| [ ] | **FAD-083 — Feature analysis CLI** | FAD-039–048 | `analyze-feature`, `review-feature`, `export-pack` akışı | JSON ve insan okunur çıktı; exit code'lar CI kullanımına uygun |
| [ ] | **FAD-084 — Agent context/handoff pack** | FAD-047, FAD-053, FAD-068 | Analiz, geliştirme, test ve review için ayrı küçük context paketleri | Her paket görev sınırı, kaynaklar, constraints ve Done kriteri içeriyor |
| [ ] | **FAD-085 — Codex/Claude/Cursor kullanım politikaları** | FAD-084 | Tool-use, freshness check, abstention ve citation talimatları | Üç istemcide aynı benchmark soruları semantik olarak tutarlı cevaplanıyor |
| [ ] | **FAD-086 — İnsan review görünümü** | FAD-048, FAD-058, FAD-075 | Markdown/terminal öncelikli review ekranı; sonraki UI için schema | Evidence, confidence, diff ve onay aksiyonu tek akışta görülebiliyor |
| [ ] | **FAD-087 — Doküman/issue export'u** | FAD-049, FAD-056, FAD-086 | BRD, analysis, test plan ve task export formatları | Stable IDs korunuyor; tekrar import round-trip duplicate yaratmıyor |

### Faz 7 çıkış kapısı

- Üç agent ailesi aynı source-of-truth ve answer contract'ı kullanmalı.
- Retrieval ile kalıcı bilgi yazma yetkisi ayrılmış olmalı.
- Agent'a yalnız mevcut görev için gerekli context verilmeli.

## Faz 8 — Evaluation, semantik kalite ve token ekonomisi

Amaç: sistemi “iyi görünüyor” seviyesinde değil, geçmiş feature'lar üzerinde ölçülmüş kaliteyle yönetmek.

| Durum | İş | Bağımlılık | Teslimat | Done / kabul kriteri |
| --- | --- | --- | --- | --- |
| [ ] | **FAD-088 — Historical feature benchmark seti** | FAD-002, FAD-039 | En az 20 geçmiş feature; pre-change SHA, gerçek repo/diff/test/karar ground truth | Sensitive veri temizlenmiş; split ve version sabit; leakage kontrolü var |
| [ ] | **FAD-089 — Repository selection metric'leri** | FAD-037, FAD-088 | Recall@k, precision, MRR, false-certainty ve abstention accuracy | Fleet ve capability segmentlerine göre rapor üretiliyor |
| [ ] | **FAD-090 — Impact accuracy metric'leri** | FAD-040, FAD-088 | Repo/file/symbol/test recall ve precision | Direct/transitive/inferred sınıfları ayrı ölçülüyor |
| [ ] | **FAD-091 — Analysis quality rubric'i** | FAD-050, FAD-088 | Completeness, correctness, ambiguity, risk, actionability ve provenance rubric | En az iki insan reviewer agreement'ı ölçülüyor |
| [ ] | **FAD-092 — Test-plan quality metric'leri** | FAD-068, FAD-088 | AC/risk coverage, redundant test ve missed regression ölçümü | Known production/test gaps benchmark'ta yakalanıyor |
| [ ] | **FAD-093 — Traceability completeness metric'i** | FAD-074, FAD-088 | Feature → requirement → code → test → release zincir coverage'ı | Broken edge ve stale evidence CI raporunda görünür |
| [ ] | **FAD-094 — Agent task evaluation** | FAD-084–085, FAD-088 | Analysis, implementation planning, testing ve review görevleri | Sonuç kalitesi, tool call, token ve latency birlikte ölçülüyor |
| [ ] | **FAD-095 — Token/cost telemetry** | FAD-008, FAD-047 | Cold/warm query token, cache hit, evidence count ve latency | Question text/secret saklamadan maliyet regression'ı yakalanıyor |
| [ ] | **FAD-096 — Retrieval ablation suite** | FAD-036–040, FAD-088 | FTS-only, vector-only, graph-only ve hybrid karşılaştırması | Her bileşenin gerçek katkısı raporlanıyor; gereksiz katman korunmuyor |
| [ ] | **FAD-097 — Embedding/reranker deney kapısı** | FAD-089–096 | E5-small baseline'a karşı aday model/reranker A/B protokolü | Model ancak kalite kazancı latency, RAM, index süresi ve lisans maliyetine değerse değişir |
| [ ] | **FAD-098 — Prompt/context regression suite** | FAD-084, FAD-094 | Answer contract, citation, uncertainty ve budget golden testleri | Prompt değişimi kalite veya token eşiğini bozarsa CI fail ediyor |
| [ ] | **FAD-099 — Quality release gate** | FAD-089–098 | Tek makine-okunur release decision raporu | Kritik metric regression'ında yeni sürüm production-ready ilan edilemiyor |

### Faz 8 çıkış kapısı

- Semantik kalite gerçek geçmiş feature'larla ölçülmeli.
- Embedding/reranker/vector DB kararı sezgiyle değil ablation ve A/B testiyle verilmeli.
- Token kazancı cevap kalitesinden ayrı değil, aynı raporda izlenmeli.

## Faz 9 — Operasyon, ölçek ve 16 repository rollout

Amaç: yerel olarak çalışan sistemi kontrollü biçimde ekip/fleet kullanımına açmak.

| Durum | İş | Bağımlılık | Teslimat | Done / kabul kriteri |
| --- | --- | --- | --- | --- |
| [ ] | **FAD-100 — SQLite kapasite benchmark'ı** | FAD-030, FAD-095 | 2/4/8/16 repo DB boyutu, sync, query ve lock davranışı | Hedef cihazda P50/P95 ve failure mode raporu var |
| [ ] | **FAD-101 — PostgreSQL migration decision record** | FAD-100 | Shared writer, RBAC, central service ve backup eşikleri | Eşik aşılmadıysa SQLite kalma kararı da açık ADR olarak kaydediliyor |
| [ ] | **FAD-102 — Backup, restore ve rebuild testi** | FAD-007 | DB/registry/approved memory backup politikası ve restore drill | Temiz ortamda restore veya deterministic reindex doğrulanmış |
| [ ] | **FAD-103 — Authentication/RBAC tasarımı** | FAD-081, FAD-101 | Shared deployment açılırsa reader/writer/approver rolleri | Local-only mod gereksiz auth zorunluluğu getirmiyor; shared mod anonymous değil |
| [ ] | **FAD-104 — Connector credential ve permission politikası** | FAD-005, FAD-056 | Issue/CI/release adapter'ları için least-privilege ve secret handling | Credential log/index'e düşmüyor; revoke/rotation yolu belgeli |
| [ ] | **FAD-105 — Observability ve SLO'lar** | FAD-032, FAD-095 | Sync failure, stale index, query latency, eval drift ve storage health | Alarm actionable; telemetry hassas metin içermiyor |
| [ ] | **FAD-106 — 2 → 4 rollout** | FAD-030, FAD-099–105 | İki yeni repo onboarding ve retrospective | Quality/freshness/token gate geçmeden sonraki dalga açılmıyor |
| [ ] | **FAD-107 — 4 → 8 rollout** | FAD-106 | Dört yeni repo, catalog review ve benchmark update | Yeni yapı varyasyonları analyzer/eval fixture'larına eklenmiş |
| [ ] | **FAD-108 — 8 → 16 rollout** | FAD-107 | Kalan repo'lar, owner/capability/test coverage | Tüm repo'lar readiness dashboard'da green veya gerekçeli excluded |
| [ ] | **FAD-109 — Operasyon ve onboarding playbook'u** | FAD-082–087, FAD-102–108 | Repo ekleme, güncelleme, failure recovery, feature analysis ve approval rehberi | Yeni ekip üyesi gözetimsiz dry-run yapıp örnek feature pack üretebiliyor |
| [ ] | **FAD-110 — Adoption ve outcome review** | FAD-108–109 | Analiz süresi, rework, escaped defect, review süresi ve token trendi | Baseline ile karşılaştırma ve sonraki çeyrek backlog'u onaylanmış |
| [ ] | **FAD-111 — Production acceptance** | FAD-099–110 | Güvenlik, kalite, recovery, docs, ownership ve rollout sign-off checklist | Açık P0/P1 risk yok; owner ve rollback tanımlı; tüm zorunlu gate'ler yeşil |

### Faz 9 çıkış kapısı

- On altı repository kalite düşmeden yönetilebilmeli.
- Recovery, freshness, security ve ownership süreçleri kişilerden bağımsız çalışmalı.
- Ürünün faydası token dışında analiz süresi, rework ve test kalitesiyle de gösterilmeli.

## Önerilen teslimat dilimleri

Roadmap sıra bağımlılıklarını korur, ancak değer üretmek için aşağıdaki release dilimleri kullanılmalıdır:

| Dilim | Kapsam | Kullanılabilir sonuç |
| --- | --- | --- |
| **R1 — Fleet discovery** | FAD-001–048 | Ham feature'dan aday repository ve kanıtlı impact pack |
| **R2 — Analysis ready** | FAD-049–058 | Onaylanabilir BRD/teknik analiz ve repo bazlı development planı |
| **R3 — Test ready** | FAD-059–068 | AC/risk tabanlı test planı ve verification traceability |
| **R4 — Delivery memory** | FAD-069–087 | Plan-vs-actual review, agent handoff ve release zinciri |
| **R5 — Measured production** | FAD-088–111 | Feature-level eval, ölçülü model kararı ve 16 repo rollout |

## Her iş için zorunlu Definition of Done

Bir checkbox ancak aşağıdakilerin tamamı sağlandığında `[x]` yapılır:

- Kod ve şema değişikliği tamamlandı.
- Unit/integration testleri ve gerekli migration fixture'ı eklendi.
- İlgili feature-level evaluation case eklendi veya neden gerekmediği yazıldı.
- Provenance, freshness, uncertainty ve token-budget davranışı doğrulandı.
- README/architecture/operations/project guide güncellendi.
- Geriye uyumluluk veya breaking-change notu yazıldı.
- Güvenlik ve redaction etkisi incelendi.
- Gerçek bir Next.js repository senaryosunda smoke test yapıldı.
- PR veya değişiklik kaydı `FAD-xxx` kimliğine bağlandı.

## Özellikle yapılmayacaklar

- LLM fine-tuning'i, retrieval ve traceability ölçülmeden başlatmak.
- Daha büyük embedding modelini otomatik olarak daha kaliteli kabul etmek.
- Yalnız vector similarity ile repository seçmek.
- Agent çıkarımını onaylanmış business rule veya ADR gibi saklamak.
- Stale index üzerinde sessizce kesin cevap üretmek.
- Test dosyası varlığını acceptance criterion'ın doğrulandığı anlamına saymak.
- PM aracını veya mimari onayı otonom olarak değiştirmek.
- İhtiyaç kanıtı olmadan PostgreSQL/vector database operasyon yükü eklemek.
- Tek seferde 2 repository'den 16 repository'ye geçmek.

## İlk başlanacak işler

İlk uygulama sprinti için sıra:

1. `FAD-001`, `FAD-002`, `FAD-003` — ürün ve truth sınırları.
2. `FAD-004` — kuruma özel sabitleri tamamen temizleme.
3. `FAD-006`, `FAD-007`, `FAD-008` — provenance, migration ve baseline.
4. `FAD-009`–`FAD-022` — work item/capability/traceability temel şeması.
5. `FAD-023`–`FAD-030` — mevcut iki proje üzerinde capability graph.
6. `FAD-033`–`FAD-048` — ilk kullanılabilir feature analysis pack.

Bu sıranın sonunda RCE, “hangi dosyada ne var?” sorusunun ötesine geçerek “bu feature neden, nerede, hangi risk ve testlerle yapılmalı?” sorusunu kanıtlı biçimde yanıtlayan ilk kullanılabilir sürüme ulaşır.
