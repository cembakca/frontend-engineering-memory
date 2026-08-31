# RCE-009 — Repository semantic graph ontology

**Tarih:** 31 Ağustos 2026  
**Makine-okunur:** [`config/graph-ontology.json`](../config/graph-ontology.json)  
**Durum:** ontoloji tanımlandı — çıkarım RCE-010, traversal RCE-011/012

## 1. Ontolojiyi belirleyen tek ayrım

Ölçülen gerçek:

| Kapsam | Sayı |
| --- | ---: |
| `src` altındaki `.ts`/`.tsx` | 63 |
| `ContactForm.tsx` import closure'ı | **14 dosya** |
| `ContactForm.tsx`'in gerçekten kullandığı dış sembol | **~6** |
| Bu sembollerin bulunduğu modül | **2** (`@/lib/captcha`, `@/lib/contact`) |
| Ortalama dosya closure'ı | 5,5 dosya (repo'nun %9'u) |
| `hakkimizda/page.tsx` closure'ı | 30 dosya (repo'nun %48'i) |

Aradaki fark barrel re-export'tan geliyor: `@/lib/captcha/index.ts` bütün modülü yeniden export ettiği için, iki modüle olan bir bağımlılık 14 dosyalık bir closure'a dönüşüyor. Bu closure bugün route memory'lerinin evidence listesi olarak saklanıyor (RCE-005) ve `/` route'unun yanlış ISR sınıflandırmasının mekanizması (RCE-008 K2/K3).

**Ontolojinin varlık nedeni tek cümlede: erişilebilirlik katkı değildir.** `imports` kenarı ile `calls`/`renders` kenarı aynı şey değildir ve aynı ağırlıkta kullanılamaz.

## 2. RCE-005 ile ilişki — occurrence ≠ edge

İki kavram karıştırılmamalı:

| | Neyi bağlar | Örnek |
| --- | --- | --- |
| `entity_occurrences.role` (RCE-005) | Bir **entity**'yi bir **dosya konumuna** | `GATEWAY_URL` `reads` rolüyle `gateway.ts:9`'da |
| Graph edge (RCE-009) | Bir **entity**'yi başka bir **entity**'ye | `getMenuList` `fetches` `GET ${GATEWAY_URL}/pages/menuitem/list` |

`role` "nerede geçiyor", edge "neyle ilişkili" sorusunu cevaplar. Node `kind` sözlüğü RCE-005'teki `entities.kind` sözlüğünün genişletilmiş halidir; yeni bir kimlik uzayı açılmaz.

## 3. Node tipleri

| Kind | Identity key | Not |
| --- | --- | --- |
| `route` | HTTP yolu | Route handler ayrı kind değil; mevcut `routes.route_type` ayrımı yeter. Ayrı kind açmak tek yola iki kimlik verirdi. |
| `module` | repo-göreli dosya yolu | |
| `symbol` | `<dosya>#<ExportAdı>` | |
| `component` | `<dosya>#<ExportAdı>` | JSX döndüren symbol. **Symbol ile aynı key uzayını paylaşır**; bir key tek node'a çözülür, `kind` en spesifik sınıflandırmadır. |
| `backend-endpoint` | `<method> <çözülmüş url şablonu>` | `POST ${GATEWAY_URL}/pages/aboutus/insertcomment` — şablon korunur ki config entity'si görünür kalsın |
| `config` | `KEY_NAME` | |
| `package` | npm veya internal paket adı | |
| `test` | `<test dosyası>#<vaka adı>` | |
| `verification-command` | `script:<package.json script adı>` | Çalıştırılabilir `test`, `typecheck`, `lint` veya `build`; tek başına coverage iddiası değildir |
| `capability` | kararlı slug | **Yalnız human-approved kaynaktan** üretilir; yoldan çıkarılmaz (RCE-006'nın sildiği placeholder'ların tekrarını engeller) |

`component` ile `symbol`'ün key uzayını paylaşması bilinçli: RCE-005'in "occurrence identity'nin parçası olamaz" kuralının graph'taki karşılığı, "sınıflandırma ikinci bir kimlik yaratamaz"dır.

## 4. Saklanan kenarlar

| Edge | from → to | Confidence | Not |
| --- | --- | --- | --- |
| `imports` | module → module | observed | **Zayıf.** Tek başına hiçbir davranışsal iddiayı gerekçelendiremez |
| `exports` | module → symbol/component | observed | |
| `calls` | symbol/component → symbol | observed | |
| `renders` | route/component → component | observed | |
| `reads` | symbol/module → config | observed | |
| `fetches` | symbol → backend-endpoint | observed / derived | Hedef sabitten veya template literal'dan kuruluyorsa `derived` |
| `submits-to` | component → route | **derived** | Sabit çözümü gerektirir (RCE-010) |
| `inherits` | route → module | observed | layout zinciri |
| `delegates-to` | route → backend-endpoint | observed | `next.config` rewrites/redirects — RCE-008 K5'i kapatır |
| `validated-by` | route/symbol → test | observed | Yalnız somut test vakası hedefi kullandığında; dosya seviyesinde kullanılmayan import yeterli değildir |
| `declares` | module → config | observed | `.env` tanımı; ortam bilgisi occurrence'da, kenarda değil |

### Zorunlu kenar nitelikleri

```text
from_entity_id, to_entity_id, edge_type, file_path, start_line, confidence, commit_sha
opsiyonel: symbol, end_line, derivation_rule, condition
UNIQUE(from_entity_id, to_entity_id, edge_type, file_path, start_line)
```

Her kenar **nerede kanıtlandığını** taşır. Kanıt konumu olmayan kenar yazılamaz — RCE-007'nin `observed` koşulunun graph karşılığı budur. `derived` kenarlar `derivation_rule` olmadan yazılamaz.

## 5. Türetilen, saklanmayan kenarlar

| Edge | Nasıl hesaplanır |
| --- | --- |
| `affected-by` | `calls`, `renders`, `reads`, `fetches`, `inherits`, `submits-to`, `references`, `delegates-to` üzerinden **ters closure** |
| `implemented-by` | yalnız human-approved capability tanımından |

Bu bir tasarım kararıdır: **`affected-by` saklanmaz.** Saklanan bir ters kenar, girdi kenarlarından biri değiştiği anda bayatlar ve iki kaynaklı gerçek üretir. Impact soruları (RCE-I01/I02/I05) traversal ile cevaplanır, denormalize tabloyla değil.

## 6. Hangi kenar hangi başarısız vakayı çözüyor

RCE-002'de başarısız olan vakaların her biri için gereken zincir:

| Vaka | Gereken kenarlar |
| --- | --- |
| **F01** iletişim akışı | `ContactForm` `calls` `getCaptchaAuth` → `calls` `resolveCaptchaAdapter` → `hcaptchaAdapter`; `ContactForm` **`submits-to`** `/api/pages/aboutus/insertcomment`; handler `calls` `readCaptchaFromBody`/`buildCaptchaHeaders`; handler `fetches` `POST ${GATEWAY_URL}/pages/aboutus/insertcomment`; handler `reads` `GATEWAY_URL` |
| **F02** newsletter | Aynı zincirin `subscribe` kolu; `submits-to` `/api/customer-services/v2/subscribes` |
| **F03** captcha token | `getCaptchaAuth` → `executeCaptcha` → `resolveCaptchaAdapter` → `hcaptchaAdapter.execute`; sonra handler'ın `buildCaptchaHeaders` çağrısı |
| **F06** menü | `layout.tsx` `calls` `getMenuList`; `layout` `renders` `SiteChrome`; her route `inherits` `layout` |
| **I01** legal impact | `manifest.ts` `exports` `legalPagesMeta` ← `agreements.ts` `calls`; `/[slug]` `renders` `AgreementArticle` — hepsi ters yönde yürünür |
| **I02** GATEWAY_URL impact | `reads` kenarlarının tersi + `fetches` + `delegates-to` (next.config rewrite'ları bugün hiç görünmüyor) |
| **I05** hcaptcha impact | `resolveCaptchaAdapter` → `hcaptchaAdapter` tek sağlayıcı; ters `calls` closure'ı iki forma ve iki handler'a çıkar |
| **D07** test stratejisi | `validated-by` kenarının **yokluğu** cevabın kendisidir |

`submits-to` kenarının tamamı `INSERT_COMMENT_URL` / `SUBSCRIBE_URL` sabitlerinin çözülmesine bağlı. Bu ontoloji o olmadan flow sorularını çözmez — bağımlılık RCE-010'dur.

## 7. Kapsam dışı

- **Cross-repository kenar yok.** RCE-005'teki repository-kapsamlı entity kuralı graph için de geçerli.
- **Runtime çağrı grafiği yok.** Kenarlar statik analizden çıkar; dinamik dispatch (`adapters[id]`) `derived` olarak ve `condition` niteliğiyle kaydedilir, kesin gerçek olarak değil.
- **`capability` yoldan üretilmez.** RCE-006'da silinen 9 placeholder'ın tekrar üretilmesini engelleyen kural budur.
- **Sıralama bu maddede yok.** Akışın adım sırası traversal'ın işidir (RCE-011); ontoloji yalnız kenarları tanımlar.

## 8. Bağımlılıklar

- **RCE-005** — entity/occurrence tabanı; bu ontoloji onun `kind` sözlüğünü genişletir.
- **RCE-010** — `calls`, `renders` ve özellikle `submits-to` için sembol seviyesi çıkarım ve sabit çözümü.
- **RCE-008** — `delegates-to` kenarı K5'i kapatır; "veri yolunda mı" sorusu (kural 4) `calls`/`renders` ile kesinleşir.
- **RCE-011/012** — flow ve change-impact traversal'ları bu kenarları tüketir.
