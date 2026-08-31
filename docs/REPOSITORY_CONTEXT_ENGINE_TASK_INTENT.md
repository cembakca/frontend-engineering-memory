# RCE-014 — Task intent modeli

**Tarih:** 31 Ağustos 2026  
**Uygulama:** [`src/retrieval/intent.ts`](../src/retrieval/intent.ts)  
**Entegrasyon:** [`src/retrieval/understand.ts`](../src/retrieval/understand.ts)  
**Test:** [`test/intent.test.ts`](../test/intent.test.ts) — 6 vaka; 50 golden soru  
**Durum:** Türkçe/İngilizce karma sorgularda açıklanabilir intent sınıflandırması

## 1. Çıktı sözleşmesi

```ts
type TaskIntent =
  | "lookup"
  | "explain-flow"
  | "impact"
  | "debug"
  | "implementation-plan"
  | "change-review"
  | "verify"
  | "unknown";

interface IntentClassification {
  intent: TaskIntent;
  confidence: "high" | "medium" | "low";
  scores: Partial<Record<Exclude<TaskIntent,"unknown">,number>>;
  signals: Array<{ intent; rule; weight; match }>;
  alternatives: TaskIntent[];
  reason: string;
}
```

Sınıflandırıcı yalnız etiketi döndürmez. Hangi metin parçasının hangi kurala kaç puan verdiği görünürdür. Bu veri RCE-015 query plan'ın neden graph, exact SQL veya source fallback seçtiğini açıklayabilmesi için korunur.

## 2. Sınıflar arasındaki sınırlar

| Intent | Güçlü sinyaller | Örnek |
| --- | --- | --- |
| `lookup` | listele, hangi dosya/route/endpoint, nerede, sürüm | “Bütün aktif route'ları listele” |
| `explain-flow` | hangi sırayla, UI→backend, zincir, nasıl dönüşür | “Token upstream header'a nasıl dönüşüyor?” |
| `impact` | değişirse, etkilenir, blast radius, risk yüzeyi | “GATEWAY_URL değişirse ne etkilenir?” |
| `debug` | hata/status, failed, bozuk, unavailable, kontrol edilmeli | “Neden 502 döner?” |
| `implementation-plan` | yeni iş ekleme, hangi pattern, hangi dosyalar değişmeli | “Yeni POST handler nasıl eklenmeli?” |
| `change-review` | diff, since SHA, working tree, indexed SHA/HEAD | “Bu commit sonrasında ne değişti?” |
| `verify` | hangi komutlar, test strategy, coverage gap, quality gate | “Hangi test boşluğu var?” |
| `unknown` | eşik altı veya eşit güçlü niyetler | “Buna bak”; source'tan cevaplanamayacak decision why |

Tek başına `nasıl` flow değildir; tek başına `neden` debug değildir. Örneğin “Ekip neden Next.js 16'yı seçti?” bir failure sorusu olmadığı ve decision-provenance sınıfı henüz bulunmadığı için `unknown` olur. Bu, source code'dan `why` uydurulmasını engeller.

Plan içinde “doğrulama adımları” geçebilir. “Yeni sayfa eklemek” güçlü implementation sinyalidir ve ikincil `verify` sinyalini ezer; buna karşılık “değişiklikten sonra hangi komutlar” doğrudan `verify` olur.

## 3. Türkçe normalizasyon

Metin locale-aware lowercase ve Unicode normalization'dan geçirilir; `ı/ş/ğ/ç/ö/ü` ASCII köklerine çevrilir. Kurallar Türkçe ekleri kapsayan kökler kullanır (`zincir*`, `etkilen*`, `değişiklik*`). İngilizce sinyaller aynı rule set içinde tutulur; ayrı bir dil tahmini yapılmaz.

## 4. Confidence ve abstention

- En yüksek skor 4'ün altındaysa `unknown/low`.
- İlk iki skor eşitse `unknown/low`; iki olası sınıf `alternatives` içinde döner.
- Skor en az 7 ve fark en az 3 ise `high`.
- Fark en az 2 ise `medium`; diğer tekil kazançlar `low`.

Bu eşikler sınıflandırma doğruluğu kadar query-plan güvenliğini korur: düşük güven ileride dar bir exact plan yerine fallback/ikinci retrieval turunu tetikleyebilir.

## 5. Golden ölçüm

`docs/REPOSITORY_CONTEXT_ENGINE_EVALUATION.md` içindeki 50 soru test sırasında doğrudan okunuyor; böylece katalog ile fixture birbirinden kopamıyor.

| Intent | Vaka |
| --- | ---: |
| lookup | 13 |
| explain-flow | 10 |
| impact | 8 |
| implementation-plan | 6 |
| debug | 6 |
| change-review | 3 |
| verify | 2 |
| unknown | 2 |
| **Toplam doğru** | **50 / 50** |

Confidence dağılımı: 20 high, 26 medium, 4 low. Low sonuçların ikisi kasıtlı `unknown` (`N07` decision why, `N08` incoming consumers); diğer ikisi birden fazla gerçek niyet taşıyan I05 impact+flow ve P01 implementation+verify sorularıdır.

## 6. Route parse düzeltmesi

Eski `understandQuery`, `src/lib/legal-pages/manifest.ts` içindeki `/lib/...` parçasını HTTP route sanabiliyordu. Yeni extraction yalnız bağımsız path token'larını kabul eder ve şunları reddeder:

- `.ts`, `.tsx`, `.js`, `.jsx`, `.json` source path'leri
- kelime/path parçasının ortasındaki slash
- `https://` ve benzeri URL slash'ları

`/`, `/iletisim` ve `/api/...` route'ları korunur. Bu değişiklik RCE-003'teki route-misparse `wrong-intent` sınıfını doğrudan kapatır.

## 7. Açık sınır

Bu madde yalnız niyeti sınıflandırır. Hangi retrieval kanalının hangi sırayla çalışacağı, ikinci turun ne zaman açılacağı ve düşük confidence davranışı RCE-015 query plan kapsamındadır.
