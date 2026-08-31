# RCE-027 — Güvenlik ve veri yönetişimi

**Tarih:** 31 Ağustos 2026  
**Politika:** [`config/data-governance.json`](../config/data-governance.json)  
**Denetim:** [`src/security/audit.ts`](../src/security/audit.ts) — `pnpm memory security-audit [repository]`  
**Test:** [`test/security-audit.test.ts`](../test/security-audit.test.ts) — 8 vaka

## 1. İlke: çalıştırılamayan kural politika değildir

Bu madde bir metin değil, bir denetim üretti. `config/data-governance.json` içindeki her kural bir invariant kimliğine bağlı (`checkedBy`) ve `security-audit` komutu o invariant'ı gerçekten sorgular. Kontrol edilemeyen bir kural yorumdur.

Denetim başarısız olduğunda **uyarmaz, kapıyı kapatır**: `security-audit` çıkış kodu 1 verir ve RCE-028/029 rollout kapılarının önkoşuludur.

## 2. Beş invariant

| ID | Kural | Ne kontrol ediyor |
| --- | --- | --- |
| **I1** | `store-key-names-never-values` | Repository'nin `.env*` dosyalarındaki gerçek değerler çıkarılır ve **her tabloda** aranır |
| **I2** | `registry-is-the-boundary` | Aktif evidence yolları repository-göreli mi; indekslenmiş her repository registry'de mi |
| **I3** | `evidence-gated-and-labelled` | AI üretimi memory'ler `producer`, `quality_score`, `inferred` confidence ve evidence taşıyor mu |
| **I4** | `shape-not-prose` | Telemetri tablosunda fact içeriği var mı |
| **I5** | `retention` | Satır ve gün pencereleri aşılmış mı |

## 3. Denetimin boşuna geçmediğinin kanıtı

Hiç başarısız olduğu görülmemiş bir denetim, başarısız **olamayan** bir denetimden ayırt edilemez. Bu yüzden her invariant kasten ihlal edilerek test edildi:

| Test | Enjekte edilen ihlal |
| --- | --- |
| I1 | `.env.production`'daki gerçek değer bir fact içeriğine yazıldı |
| I2 | Evidence yolu `/etc/passwd` yapıldı |
| I2 | Registry'de olmayan bir repository indekslendi |
| I3 | AI memory'si `quality_score` olmadan yazıldı |
| I4 | Fact içeriği telemetri satırına kopyalandı |
| I5 | Deaktive memory 200 gün geriye tarihlendi |

Sekizinci test, ölçülemeyen durumun **`skipped` döndüğünü** doğruluyor — env dosyası yoksa I1 `pass` değil `skipped` olur. Hiçbir kod yolu, ölçemediği bir şeyi geçmiş saymaz.

## 4. Canlı pilot sonucu

```json
{
  "invariants": [
    { "id": "I1-no-env-values", "status": "pass", "detail": "24 env values checked against 12 tables" },
    { "id": "I2-indexed-paths-inside-registry", "status": "pass" },
    { "id": "I3-ai-memories-labelled", "status": "pass" },
    { "id": "I4-telemetry-carries-no-content", "status": "pass", "detail": "175 fact bodies checked against telemetry" },
    { "id": "I5-retention-within-policy", "status": "pass" }
  ],
  "failed": 0, "skipped": 0, "ok": true
}
```

Ayrıca elle yapılan ilk taramada, dört `.env*` dosyasından çıkarılan **28 gerçek değerin hiçbiri** hiçbir tabloda bulunmadı. "Sır şekilli" görünen eşleşmeler dosya yolları ve SHA-1 hash'leriydi (source hash ve commit SHA) — meşru veri.

## 5. Politika alanları

### Secret / env value redaction

Konfigürasyon analizi **anahtar adını, dosyayı ve satırı** kaydeder; atanan değeri hiçbir zaman fact'e, evidence satırına, telemetriye veya snapshot'a okumaz. RCE-005'in occurrence modeli bu kuralı gevşetmez: dört ortamda tanımlı bir anahtar dört occurrence üretir, dört değer değil.

### Repository erişim sınırı

Registry sınırdır. Yalnız listelenen repository'ler okunur; analiz repository kökünün içinde kalır, yapılandırılmış `distDir` ve `node_modules` atlanır. RCE-006'da ölçüldüğü gibi generated output aktif retrieval'a sızmıyor; I2 bunu her koşuda yeniden doğrular.

### AI extraction verisi

Normal indeksleme ve retrieval **hiçbir zaman** harici bir modele çağrı yapmaz. `ai-extract` açık bir komuttur; çıktısı yalnız desteklenen tiplerde, eşik üstü güvenle ve beyan edilen dosya/satır aralığında doğrulanabilir bir alıntıyla kabul edilir. Üretilen memory `producer`, `quality_score` ve `inferred` confidence taşımak zorundadır — I3 bunu zorunlu kılar.

### Retention

| Veri | Pencere |
| --- | --- |
| `retrieval_events` | 5.000 satır (`MEMORY_TELEMETRY_RETENTION`) |
| `index_run_changes` | 20 index run |
| Deaktive memory'ler | 90 gün |
| `answer_feedback` | 365 gün |
| `repository_snapshots` | repository başına 10 snapshot |

Deaktive memory penceresi RCE-006'da yüzeye çıkan gerçek bir sorunu kapsıyor: pilotta 859 pasif kayıt ve onlara ait 634 generated-evidence satırı süresiz duruyordu. Retrieval'a sızmıyorlar ama süresiz saklanmaları bir saklama politikası sorunuydu.

### Audit politikası

Her sync koşusunda ve her rollout kapısından önce çalışır. Başarısız invariant kapıyı bloke eder.

## 5.1 MCP HTTP ucu (`/mcp`)

`serve` aynı üç tool'u HTTP üzerinden de sunar. Güvenlik duruşu:

- **Varsayılan olarak yalnız localhost.** Sunucu `127.0.0.1`'e bağlanır; uç ağdan erişilebilir değildir.
- **Kimlik doğrulama yoktur.** MCP handler istek başlıklarından yetki türetmez ve token doğrulamaz.
- **Yüzey salt okunurdur.** Üç tool da `readOnlyHint` taşır; bir test bunu HTTP tarafında da doğrular.
- **`MEMORY_HOST=0.0.0.0` bilinçli bir karardır.** Bu, salt okunur MCP tool'larıyla birlikte hâlihazırda
  var olan `POST /sync` ve `POST /full-index` uçlarını da ağa açar. Bu durumda kimlik doğrulamalı bir
  ters vekil zorunludur; aksi halde herhangi biri indekslemeyi tetikleyebilir.
- **Durum tutulmaz.** Her istek paylaşılan veritabanı tanıtıcısı üzerinde taze bir sunucu alır, bu yüzden
  uzun ömürlü süreçte oturum durumu birikmez.

## 6. Bilinçli sınırlar

- **I1 altı karakterden kısa değerleri atlar.** `1`, `true`, `dev` gibi değerler sıradan kelimelerle çakışır ve sızıntı sinyali olarak kullanılamaz. Bu, yanlış pozitifi değil, **kaçırılan gerçek bir vakayı** göze alır; kısa sırlar zaten sır değildir ama kural açıkça yazılmalıdır.
- **`repository_decisions.rationale` serbest metindir** ve insan tarafından yazılır (RCE-022). Denetim bu alanı sır açısından tarayamaz; politika, karar kaydına sır yazılmamasını insan onay adımına bırakır.
- **`answer_feedback.note` de serbest metindir** (RCE-025) ve aynı sınır geçerlidir.
- **Denetim, dosya sisteminde ne olduğunu değil, veritabanında ne olduğunu ölçer.** Repository'nin kendisindeki sırlar bu sistemin sorumluluğu değildir.

## 7. Bağımlılıklar

- **RCE-024** — I4 telemetri whitelist'ini doğrular.
- **RCE-022** — karar kaydının serbest metin sınırı.
- **RCE-006** — retention ihtiyacını yüzeye çıkaran ölçüm.
- **RCE-028/029** — rollout kapıları bu denetimin `ok:true` dönmesini şart koşar.
