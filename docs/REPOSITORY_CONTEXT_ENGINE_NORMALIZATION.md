# RCE-005 — Entity/evidence normalizasyon tasarımı

**Tarih:** 31 Ağustos 2026  
**Baseline ölçümü:** `pnpm memory quality hangikredi.aboutus.fe.next`  
**Durum:** tasarım — uygulama RCE-009/010 ile aynı migration'da yapılmalı

## 1. Ölçülen sorun

| Metrik | Pilot | Anlamı |
| --- | ---: | --- |
| `activeMemories` | 175 | Depolanan satır |
| `canonicalSubjects` | **107** | Gerçekte kaç ayrı konu var |
| `duplicationRatio` | **0,3886** | Satırların %39'u yeni bilgi taşımıyor |
| `environmentOnlyConfigMemories` | **66** | Yalnız `.env*` dosyasından gelen, davranış anlatmayan config kaydı |
| `broadEvidenceMemories` | **9** | Evidence olarak 4'ten fazla dosya gösteren memory (dokuz route memory'sinin tamamı) |

Config tarafında tablo daha keskin: **84 `configuration` memory = 19 benzersiz key** (%77 tekrar). Bunun 66'sı `.env*` dosyalarından geliyor:

| Dosya | Kayıt |
| --- | ---: |
| `.env.production` | 17 |
| `.env.test` | 17 |
| `.env.corlu.production` | 16 |
| `.env.staging` | 16 |

Yani her key dört kez, neredeyse aynı cümleyle kaydediliyor.

## 2. `GATEWAY_URL` — tek kavram, dört model, 18 satır

| Model | Satır | İçerik |
| --- | ---: | --- |
| `memories` (`configuration`) | 6 | `next.config.ts:141`, `src/lib/gateway.ts:9` + dört `.env*` |
| `memories` (`dependency`) | 2 | `config:GATEWAY_URL` |
| `dependencies` | 2 | `dependency_type='config'` |
| `route_dependencies` | 9 | route başına kullanım |

Depolanan altı config cümlesinin tamamı şu şablonun kopyası:

```text
Configuration key GATEWAY_URL is referenced by next.config.ts.
.env.production declares configuration key GATEWAY_URL.
```

Bunlar **fact değil, occurrence.** Asıl fact — "GATEWAY_URL internal cluster gateway base URL'idir; gateway/menu fetch'leri ve iki POST handler'ı buna bağlıdır; boş string bu yolları sessizce devre dışı bırakır" — hiçbir satırda yok. RCE-002'de `RCE-I02`'nin (GATEWAY_URL impact) `wrong-intent` ile başarısız olmasının altındaki yapısal neden budur.

## 3. Kök neden — occurrence, identity'nin parçası

Her iki modelde de aynı hata var:

```sql
-- mevcut
UNIQUE(repository_id, dependency_type, name, source_file)
--                                            ^^^^^^^^^^^ kimliğin parçası
```

`memories` tarafında kısıt bile yok: her occurrence yeni bir satır. Sonuç, aynı şeyin dosya sayısı kadar "ayrı bilgi" gibi davranması. Retrieval açısından bedeli doğrudan: `limit: 5`'lik bir pencerede aynı key'in dört kopyası dört slot yer.

**Tasarımın tek kuralı: occurrence asla identity'nin parçası olamaz.**

## 4. Kanonik model

Üç katman: **entity** (ne), **occurrence** (nerede), **claim** (ne olduğu).

```sql
CREATE TABLE entities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,   -- config | npm | internal-package | http-endpoint
                                 -- | route | module | symbol | component | test | capability
  key           TEXT NOT NULL,   -- GATEWAY_URL | @hangikredi/tokens | /api/... | src/lib/menu.ts#getMenuList
  display_name  TEXT,
  first_seen_sha TEXT,
  last_seen_sha  TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  UNIQUE(repository_id, kind, key)          -- occurrence YOK
);

CREATE TABLE entity_occurrences (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,   -- declares | reads | writes | references
                                 -- | passes-through | documents
  file_path     TEXT NOT NULL,
  symbol        TEXT,
  start_line    INTEGER,
  end_line      INTEGER,
  environment   TEXT,            -- yalnız .env* için: test | staging | production | corlu.production
  file_hash     TEXT,
  commit_sha    TEXT,
  UNIQUE(entity_id, role, file_path, start_line)
);

CREATE TABLE memory_entities (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY(memory_id, entity_id)
);
```

`memories` tablosu kalır ama anlamı değişir: bir memory artık **bir entity hakkındaki iddia**dır, occurrence kaydı değil. Bir entity'nin tipik olarak **bir** davranış memory'si ve **N** occurrence'ı olur.

### `role` sözlüğü

RCE-009 edge adlarıyla uyumlu seçildi ki graph maddesi bunu yeniden tanımlamak zorunda kalmasın:

| Role | Anlamı | `GATEWAY_URL` örneği |
| --- | --- | --- |
| `declares` | Değer burada tanımlanıyor | `.env.production:18` |
| `reads` | Runtime'da okunuyor | `src/lib/gateway.ts:9` (`process.env.GATEWAY_URL`) |
| `passes-through` | Başka bir hedefe enterpole ediliyor | `next.config.ts:141` (rewrite destination) |
| `references` | İsmen geçiyor, davranış yok | dokümantasyon, tip |
| `documents` | Açıklayan yorum/ADR | — |
| `writes` | Değer üretiliyor | — |

### Config için environment matrisi

Dört `.env` dosyası dört memory üretmez; tek entity'nin occurrence'ları olur. Bu, bugün üretilemeyen iki sinyali **bedava** kazandırır:

- `.env`'de tanımlı ama hiçbir source dosyasında okunmayan key → ölü konfigürasyon
- Source'da okunan ama hiçbir `.env`'de tanımlı olmayan key → eksik konfigürasyon riski
- Yalnız bazı ortamlarda tanımlı key → ortam sapması

**Güvenlik kuralı (RCE-027 ile bağlantılı):** occurrence yalnız key adını, dosyayı ve satırı saklar. `.env` **değeri hiçbir koşulda saklanmaz.** Mevcut davranış budur ve normalizasyon bunu gevşetmez.

## 5. Mevcut modellerin karşılığı

| Bugün | Yarın |
| --- | --- |
| `memories(configuration)` × 84 | 19 `entities(kind='config')` + 84 `entity_occurrences` + key başına 1 davranış memory'si |
| `dependencies` × 31 (`UNIQUE` içinde `source_file`) | `entities(kind ∈ npm/internal-package/http-endpoint/config)` + occurrences |
| `memories(dependency)` × 31 | aynı entity'lere bağlı claim'ler; kopya satır kalmaz |
| `route_dependencies` × 112 | `entities(kind='route')` → `entities(...)` arası kenar (RCE-009) |
| Route memory'sinin 20–36 dosyalık `memory_evidence` listesi | Kaldırılır. Route memory'si yalnız kendi source dosyasını gösterir; erişilebilirlik graph kenarı olarak ifade edilir |

Son satır kritik: `route:/hakkimizda` bugün **36 dosyayı** evidence gösteriyor — pilot'un 63 source dosyasının %57'si. Bu, evaluation contract'ın "citation correctness" metriğini route memory'lerinde geçersiz kılıyor. Normalizasyon bunu ortadan kaldırır.

## 6. Migration

Yeniden analiz gerekmiyor; mevcut satırlardan deterministik türetilebilir:

1. `entities`'i `(repository_id, kind, key)` üzerinde distinct ile doldur — `configuration` memory subject'i, `dependencies.name`, route adı.
2. Her mevcut satırı occurrence'a çevir; `role`'ü içerik şablonundan çıkar (`declares configuration key` → `declares`, `is referenced by` → `reads`, `next.config.ts` rewrite → `passes-through`).
3. `memory_entities` bağlarını kur.
4. Her entity için tek davranış memory'si bırak, kopyaları `removed_sha` ile deaktive et.
5. FTS ve vector indekslerini kanonik satırlardan yeniden üret — vektör sayısı 175'ten ~107'ye düşer.

Pilot tam indeks zaten saniyeler sürdüğü için pratikte `full` yeniden çalıştırmak da yeterlidir; migration script'i asıl olarak çok repolu kurulum için gereklidir.

## 7. Ne kazandırıyor — doğrulanabilir hedefler

Uygulandığında `pnpm memory quality` şu değerlere gitmeli:

| Metrik | Şimdi | Hedef |
| --- | ---: | ---: |
| `activeMemories` | 175 | ~107 |
| `duplicationRatio` | 0,3886 | **≤ 0,05** |
| `environmentOnlyConfigMemories` | 66 | **0** (occurrence'a dönüşür) |
| `broadEvidenceMemories` | 9 | **0** |
| `symbolCoverage` | 0,3086 | ≥ 0,60 (occurrence symbol taşır) |

Retrieval tarafında beklenen etki:

- **RCE-I02** (`GATEWAY_URL` impact) tek entity + 18 occurrence ile cevaplanabilir hale gelir; bugün dört ayrı modele dağılmış durumda.
- `limit: 5` penceresi aynı key'in kopyalarıyla dolmaz → RCE-003'ün `over-retrieval` uyarısı (9 vaka) doğrudan azalır.
- **RCE-004'ün açık kalemi kapanır:** `duplicate retrieval` metriği kanonik `entity_id` üzerinden hesaplanabilir hale gelir. Bugün aynı gerçek hem route SQL satırı hem `rendering` memory'si olarak dönüp iki kez sayılıyor ve ölçülemiyor.

## 8. Sınırlar

- **Entity repository kapsamlıdır.** A repo'sundaki `GATEWAY_URL` ile B repo'sundakini birleştirmek yasak; farklı cluster, farklı anlam olabilir. Cross-repository ilişki bu sürümün kapsamı dışında.
- **Normalizasyon bir fact üretmez.** 84 satırı 19'a indirmek, eksik olan davranış fact'ini yaratmaz. `GATEWAY_URL`'in ne işe yaradığı hâlâ yazılmıyor — onu RCE-010 (modül sözleşmesi / export davranışı) getirecek. Bu iki madde birlikte uygulanmalıdır; yalnız normalizasyon yapılırsa memory sayısı düşer ama RCE-003'teki `missing-fact` sınıfı olduğu yerde kalır.
- **Placeholder temizliği bu maddede değil.** Değersiz `business_capability` ve `performance_observation` kayıtları kanonikleştirilse de değersiz kalır; onları retrieval'dan çıkarmak RCE-006'nın işidir.
