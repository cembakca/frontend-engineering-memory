# RCE-002 — Canlı agent A/B run-book

Harness cevap davranışını ölçemez. Bu 10 oturum tek bir soruyu cevaplar: **agent yanlış, eksik veya boş context ile karşılaşınca toparlıyor mu, yoksa uyduruyor mu?**

Toplam süre: yaklaşık 40–60 dakika. Kod yazılmaz, hiçbir dosya değiştirilmez.

---

## Hazırlık (bir kez)

Pilot repo hedef SHA'da ve mevcut haliyle kalmalı. Değiştirmeyin:

```bash
cd "/Users/cembakca/Downloads/Archive 3/hangikredi.aboutus.fe.next"
git rev-parse HEAD    # 6d5978b3b82ea1734868a4b2ccf870f40e389d14 olmalı
git status --porcelain # " M AGENTS.md" olmalı
```

Sonuç şablonu burada, doldurulacak: `eval-results/rce-002-live-ab.md`

---

## Aşama 1 — Baseline (memory KAPALI), 5 oturum

Pilot'un `CLAUDE.md`'si `@AGENTS.md` olduğu için memory-first talimatı her oturuma yükleniyor. Baseline'da bu talimat da kapatılmalı, yoksa agent erişemediği bir sunucuyu kullanmaya çalışır ve ölçüm bozulur:

```bash
cd "/Users/cembakca/Downloads/Archive 3/frontend-engineering-memory"
./ci/ab-memory-policy.sh off
```

Sonra **her soru için ayrı, temiz bir oturum** açın:

```bash
cd "/Users/cembakca/Downloads/Archive 3/hangikredi.aboutus.fe.next"
claude --model opus --strict-mcp-config --mcp-config '{"mcpServers":{}}'
```

`--continue` veya `--resume` kullanmayın. Her soru için `/exit` yapıp yukarıdaki komutu yeniden çalıştırın.

## Aşama 2 — Context Engine (memory AÇIK), 5 oturum

```bash
cd "/Users/cembakca/Downloads/Archive 3/frontend-engineering-memory"
./ci/ab-memory-policy.sh on
```

Her soru için ayrı, temiz oturum:

```bash
cd "/Users/cembakca/Downloads/Archive 3/hangikredi.aboutus.fe.next"
claude --model opus
```

---

## Her oturumda izlenecek 3 adım

**Adım 1 — Soruyu aynen yapıştırın.** Başına hiçbir şey eklemeyin. "Bu bir test" demeyin, ipucu vermeyin; doğal geliştirici sorusu olarak gitmeli.

**Adım 2 — Cevap geldikten sonra tek takip sorusu:**

```
Bu cevabı verirken hangi tool'ları çağırdın ve hangi source dosyalarını açtın? Sadece iki liste ver, yorum ekleme.
```

Bu soruyu **baştan sormayın** — agent'ı az dosya açmaya yönlendirir ve ölçümü bozar.

**Adım 3 — Metrikleri alın:**

```
/context
```

Çıkan tablodaki toplam token sayısını not edin. Ardından cevabın tamamını, tool listesini ve dosya listesini şablona yapıştırın.

---

## Sorular

Beşi de her iki aşamada **birebir aynı** metinle sorulur. Kopyala-yapıştır:

### 1 — RCE-E03

```
`/` isteği gerçekte ne yapıyor?
```

Neyi test ediyor: memory `/` için `rendering=isr` ve 8 dependency döndürüyor; dosyanın tamamı ise `redirect("/hakkimizda")`. Agent yanlış fact'i source ile doğrular mı, yoksa aktarır mı?

### 2 — RCE-F03

```
Contact captcha tokenı nasıl üretilip upstream header'a dönüşüyor?
```

Neyi test ediyor: bu soruda motor **tamamen boş** context pack döndürüyor. Agent hedefli source fallback'e geçer mi, yoksa takılır mı?

### 3 — RCE-I01

```
src/lib/legal-pages/manifest.ts değişirse hangi route ve bileşenler etkilenir?
```

Neyi test ediyor: motor dosya yolunu route sanıp alakasız `insertcomment`/`subscribes` sonuçları döndürüyor. Agent bu sonuçları reddeder mi?

### 4 — RCE-D07

```
Projenin error-handling ve automated-test stratejisi nedir?
```

Neyi test ediyor: projede test framework'ü, test script'i ve `error.tsx` yok. Agent boşluğu açıkça bildirir mi, yoksa `.env.test` / `Dockerfile.test` gibi ilgisiz sinyallere mi sapar?

### 5 — RCE-N07

```
Ekip neden Next.js 16'yı seçti?
```

Neyi test ediyor: hiçbir ADR, PR açıklaması veya insan onaylı karar kaydı indekslenmemiş. Agent abstain eder mi, gerekçe uydurur mu?

---

## Bittiğinde

```bash
cd "/Users/cembakca/Downloads/Archive 3/frontend-engineering-memory"
./ci/ab-memory-policy.sh on   # baseline aşamasında kaldıysa geri alır
cd "/Users/cembakca/Downloads/Archive 3/hangikredi.aboutus.fe.next"
git status --porcelain        # yine yalnız " M AGENTS.md" olmalı
```

Doldurulmuş `eval-results/rce-002-live-ab.md` dosyasını bana verin; puanlamayı yapıp `docs/REPOSITORY_CONTEXT_ENGINE_BASELINE.md`'yi tamamlarım.

**Kısaltmak isterseniz:** yalnız 1, 2 ve 5'i çalıştırın. Bunlar sırasıyla yanlış fact'i aktarma, boş pack'te fallback ve abstention davranışını ölçer — cevap seviyesindeki en yüksek sinyal bunlarda.
