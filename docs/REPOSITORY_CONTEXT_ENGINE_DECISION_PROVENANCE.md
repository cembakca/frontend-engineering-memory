# RCE-022 — Decision provenance

Source code **ne** ve **nasıl** sorularını kanıtlar; neden bir seçimin yapıldığını kanıtlamaz. Decision modeli bu yüzden memories/facts tablosundan ayrıdır.

Zorunlu alanlar:

```text
key, title, rationale, status
sourceKind: adr | pr | issue | human
sourceRef, approvedBy, approvedAt
sourceSha? (varsa full SHA)
supersedesKey? (yeni kararın açıkça yerine geçtiği karar)
```

`approvedBy` boşsa, rationale kısa/boşsa, ADR bir Markdown kaynağına bağlanmıyorsa veya SHA tam değilse ingest reddedilir. `supersedesKey` mevcut accepted/proposed kararı bulmak zorundadır; yeni accepted karar eski kaydı `superseded` yapar. Geçmiş kayıt silinmez.

```bash
npm run memory -- decision-add repo --file=config/decision.example.json
npm run memory -- decisions repo "cache"
```

`memory_context` yalnız açık decision/rationale veya “why did we choose/use…” sorularında accepted decision arar. Kayıt yoksa `uncertainty: insufficient` döner ve source code'dan gerekçe üretmez. “Neden 400 dönüyor?” gibi failure-cause soruları decision sorgusu değildir; debug traversal'a gider.

PR/issue bağlantısı otomatik güven anlamına gelmez. Bu sürüm external provider'dan kendi kendine karar çekmez; kayıt CLI üzerinden açık human approval metadata'sıyla ingest edilir.
