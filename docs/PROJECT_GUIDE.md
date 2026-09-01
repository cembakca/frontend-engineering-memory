# Project lifecycle guide

Bu rehber, Frontend Engineering Memory'ye yeni bir Next.js projesi eklerken ve daha önce eklenmiş bir proje güncellendiğinde izlenecek operasyonel akışı tanımlar.

Komutlar `frontend-engineering-memory` dizininden çalıştırılmalıdır. Örneklerdeki `company.web.next`, proje adıyla; `/absolute/path/to/company.web.next` ise gerçek mutlak proje yolu ile değiştirilmelidir.

## 1. Hangi dosya ne işe yarar?

| Dosya | Amaç | Git durumu |
| --- | --- | --- |
| `config/repositories.json` | Bu makinede indexlenecek repository adlarını, mutlak yollarını ve alias'larını tutar | Yerel; `.gitignore` içinde |
| `config/evaluation-fleet.json` | Her repository'nin mimari ailesini, rolünü ve evaluation suite'ini tanımlar | Ortak; commitlenir |
| `config/context-engine-eval.*.json` | Repository'ye ait gerçek geliştirici sorularını ve beklenen source kanıtlarını tutar | Ortak; commitlenir |
| `data/engineering-memory.sqlite` | Üretilmiş memory, graph, vector, snapshot ve telemetry verisi | Yerel; `.gitignore` içinde |
| Hedef projenin `AGENTS.md`/`CLAUDE.md` dosyası | Agent'a memory-first kullanım politikasını verir | Hedef projenin kendi politikasına göre commitlenir |

Önemli sonuç: `repositories.json` içine proje eklemek tek başına onboarding'i tamamlamaz. Fleet manifesti ve curated evaluation suite de eklenmelidir.

## 2. İki temel kural

1. Hedef repository bir commit üzerinde ve tamamen clean olmalıdır. Engine uncommitted source'u mevcut commit SHA'sına aitmiş gibi indexlemez.
2. Evaluation suite içindeki `targetSha`, indexlenen ve test edilen gerçek commit olmalıdır. Sadece gate'i geçirmek için SHA değiştirilmez.

Kontrol:

```bash
git -C /absolute/path/to/company.web.next status --short
git -C /absolute/path/to/company.web.next rev-parse HEAD
```

İlk komut çıktı vermemelidir. Değişiklik varsa önce hedef projede normal ekip akışıyla commit, stash veya revert yapılmalıdır.

## 3. Yeni proje ekleme

### Adım 1 — Projeyi hazırlayın

- Projenin geçerli bir Git repository olduğundan emin olun.
- Indexlenecek commit'in doğru branch'te bulunduğunu doğrulayın.
- Working tree'yi clean hale getirin.
- Agent entegrasyonu kullanılacaksa `config/AGENTS.memory.example.md` içindeki policy bloğunu hedef projenin mevcut `AGENTS.md`, `CLAUDE.md` veya eşdeğer dosyasına birleştirin. Mevcut talimat dosyasını körlemesine ezmeyin.
- Bu policy değişikliği hedef projeye yapıldıysa önce onu commit edin; ardından index alın.

Örnek:

```bash
git -C /absolute/path/to/company.web.next branch --show-current
git -C /absolute/path/to/company.web.next status --short
git -C /absolute/path/to/company.web.next rev-parse HEAD
```

### Adım 2 — Mimari aileyi seçin

Mevcut benzer Next.js projeleri için iki aile vardır:

| Aile | Ne zaman seçilir? |
| --- | --- |
| `content-site` | İçerik ağırlıklı App Router, statik/ISR sayfalar, formlar ve küçük gateway yüzeyi |
| `product-app` | Ürün akışları, auth/session, React Query veya benzeri data katmanı, dinamik formlar ve geniş route yüzeyi |

Ürün adı farklı olduğu için yeni aile açılmaz. Pages/Hybrid Router, esas mutation sınırı olarak Server Actions, farklı auth/session modeli veya belirgin biçimde farklı state/data-fetching topolojisi varsa yeni bir aile değerlendirilir. Yeni aile, 5–7 soruluk overlay yerine 10–15 soruluk representative suite gerektirir.

### Adım 3 — Yerel registry'ye ekleyin

`config/repositories.json` içine yeni kayıt ekleyin:

```json
{
  "name": "company.web.next",
  "path": "/absolute/path/to/company.web.next",
  "mainBranch": "main",
  "managedCheckout": false,
  "queryAliases": {
    "ekibin kullandığı ürün terimi": ["SourceSymbol", "backend-term"]
  }
}
```

- Geliştirici checkout'u için `managedCheckout:false` kullanın.
- `queryAliases` zorunlu değildir. Yalnız ürün dilindeki terim ile source adı gerçekten farklıysa ekleyin.
- Secret, token, kullanıcı verisi veya environment value eklemeyin.
- Repository adı bütün komutlarda ve fleet manifestinde birebir aynı yazılmalıdır.

Registry'nin okunduğunu doğrulayın:

```bash
pnpm memory repos
```

Bu aşamada `pnpm eval:fleet:validate`, yeni repository henüz manifeste atanmadığı için bilinçli olarak hata verebilir.

### Adım 4 — İlk full index'i oluşturun

```bash
pnpm memory full company.web.next
```

Başarılı sonuçta `type: "FULL"`, doğru repository adı, beklenen SHA, route sayısı ve oluşturulan memory sayıları görünmelidir.

Ardından temel kontrolleri çalıştırın:

```bash
pnpm memory status
pnpm memory routes company.web.next
pnpm memory dependencies company.web.next
pnpm memory embedding-status
pnpm memory quality company.web.next
pnpm memory freshness company.web.next
pnpm memory security-audit company.web.next
```

En az bir gerçek ürün terimi ve bir teknik soruyla retrieval'ı kontrol edin:

```bash
pnpm memory search "kullanıcı bu akışa hangi sayfadan giriyor?" --repo=company.web.next
pnpm memory search "bu route hangi servis ve config değerlerini kullanıyor?" --repo=company.web.next
```

Route listesi veya repository profili bariz biçimde eksikse evaluation hazırlamaya geçmeden analyzer/index sorununu çözün.

### Adım 5 — Repository overlay taslağını üretin

Benzer iki aileden birine giren yeni repository için:

```bash
pnpm memory eval-scaffold company.web.next --family=product-app > config/context-engine-eval.company-web.json
```

Hedef suite dosya adının daha önce kullanılmadığını kontrol edin; shell'deki `>` mevcut aynı adlı dosyayı ezer. Üretilen dosya bilinçli olarak `draft:true` ve `TODO` strict fact'lerle gelir. Bu dosya doğrudan kabul edilemez.

### Adım 6 — Soruları source üzerinden curate edin

Her vaka için:

1. Soruyu, geliştiricinin gerçekten soracağı repository-specific bir soruya dönüştürün.
2. `strictFact` içindeki `TODO` değerini source'tan doğrulanmış kısa gerçekle değiştirin.
3. `expectedEvidence` listesini cevabı kanıtlayan minimum dosya setiyle sınırlandırın.
4. En olası yanlış yorumu `forbiddenClaims` içine ekleyin.
5. Route, sembol veya dosya yeniden adlandırılmışsa soru ve plan argümanlarını gerçek adlarla düzeltin.
6. Suite'in `targetSha` değerinin `git rev-parse HEAD` ile aynı olduğunu doğrulayın.
7. Bütün vakalar kaynak üzerinden kontrol edildikten sonra `draft:false` yapın.

Overlay 5–7 vaka içermeli ve en az şu işleri kapsamalıdır:

- `lookup`
- `flow`
- `impact`
- `verify`
- `negative`

Mümkünse `implementation` ekleyin. Repository'de route handler varsa yedinci vaka olarak gerçek bir `debug` koşulu tercih edin.

### Adım 7 — Fleet manifestine ekleyin

`config/evaluation-fleet.json` içindeki `repositories` listesine kayıt ekleyin. Suite yolu manifestin bulunduğu `config/` dizinine göre relative yazılır:

```json
{
  "repository": "company.web.next",
  "family": "product-app",
  "role": "overlay",
  "suite": "context-engine-eval.company-web.json"
}
```

Her ailede yalnız bir `representative` olabilir. Aynı aileye eklenen diğer projeler `overlay` olmalıdır.

### Adım 8 — Yapısal doğrulama ve retrieval gate

Önce hızlı yapısal kontrolü çalıştırın:

```bash
pnpm eval:fleet:validate
```

Bu kontrol şunları reddeder:

- registry'de olup manifestte olmayan repository;
- yanlış aile veya birden fazla representative;
- 5–7 aralığı dışında overlay;
- eksik zorunlu job;
- `draft:true`;
- `TODO` strict fact;
- eksik evidence/plan veya tekrarlanan vaka kimliği.

Ardından bütün repository suite'lerini gerçek retrieval üzerinden çalıştırın:

```bash
pnpm eval:fleet
```

Beklenen sonuç `decision: "pass"` olmalıdır. `hold` sonucunda rapordaki check ve miss sınıfını çözmeden onboarding tamamlanmış sayılmaz.

### Adım 9 — Agent bağlantısını doğrulayın

Engine source kodu değişmediyse yalnız yeni veri indexlendiği için build almak gerekmez. Uzun süredir açık bir MCP client eski tool schema kullanıyorsa veya engine kodu değiştiyse:

```bash
pnpm build
```

Sonra Codex, Claude veya Cursor MCP sürecini yeniden başlatın. Agent ile üç smoke soru sorun:

1. “Bu repository'nin router türü ve ana route'ları nedir?”
2. “Belirli bir kullanıcı akışı UI'dan backend'e nasıl gider?”
3. “Bu dosya değişirse hangi route ve bileşenler etkilenir?”

Cevap repository adını, indexed SHA'yı ve source evidence'ı taşımalıdır. Memory yetersizse agent yalnız `sourceFallback` dosyalarını açmalıdır.

### Adım 10 — Paylaşılan dosyaları commit edin

Frontend Engineering Memory repository'sinde şunları commit edin:

- yeni `config/context-engine-eval.*.json` suite'i;
- güncellenen `config/evaluation-fleet.json`;
- gerekiyorsa ortak dokümantasyon veya alias örnekleri.

Şunları commit etmeyin:

- `config/repositories.json`;
- `data/engineering-memory.sqlite` ve yan dosyaları;
- `.env`, model cache veya `eval-results/` çıktıları.

## 4. Mevcut proje güncellendiğinde

Bu akış, hedef Next.js repository'ye yeni commit geldiğinde uygulanır.

### Adım 1 — Eski indexed SHA'yı not edin

```bash
pnpm memory status
```

İlgili repository'nin `lastSha` değerini saklayın. Bu değer behavior diff ve değişiklik incelemesinde `from` SHA olacaktır.

### Adım 2 — Hedef checkout'u doğru ve clean commit'e getirin

Developer checkout'unu normal Git akışınızla güncelleyin. Engine fetch/pull işlemini yalnız `managedCheckout:true` olan service-owned clone için yapar.

```bash
git -C /absolute/path/to/company.web.next branch --show-current
git -C /absolute/path/to/company.web.next status --short
git -C /absolute/path/to/company.web.next rev-parse HEAD
```

`status --short` çıktı veriyorsa sync çalıştırmayın. Yeni kod henüz commitlenmediyse memory içinde güvenilir bir SHA ile temsil edilemez.

### Adım 3 — Önce yalnız değişen repository'yi sync edin

```bash
pnpm memory sync company.web.next
```

Sonucu şöyle yorumlayın:

| Sonuç | Anlamı |
| --- | --- |
| `INCREMENTAL` | Eski indexed SHA ile yeni HEAD arasındaki ilgili dosyalar, graph, route ve vector kayıtları güncellendi |
| `NOOP` | HEAD değişmedi; route/snapshot reconciliation yine yapıldı |
| `FULL` | İlk index yapıldı veya eski SHA yeni HEAD'in ancestor'ı değildi; güvenli full index uygulandı |
| Hata | Database ilerletilmedi; working tree, branch, path veya Git durumunu düzeltip yeniden çalıştırın |

Bir repository üzerinde sorun çözerken `sync-all` yerine önce `sync <repository>` kullanmak daha okunaklı sonuç verir.

### Adım 4 — Değişikliğin memory etkisini inceleyin

Yeni SHA'yı `pnpm memory status` veya hedef repository'deki `git rev-parse HEAD` çıktısından alın.

```bash
pnpm memory changes company.web.next --since=OLD_INDEXED_SHA
pnpm memory snapshots company.web.next
pnpm memory behavior-diff company.web.next --from=OLD_INDEXED_SHA --to=NEW_HEAD_SHA
```

Sonra değişikliğin türüne göre hedefli kontrol yapın:

```bash
pnpm memory routes company.web.next
pnpm memory dependencies company.web.next
pnpm memory route-dependencies company.web.next --route=/account
pnpm memory search "değişen kullanıcı akışı nedir?" --repo=company.web.next
```

Özellikle şunları kontrol edin:

- eklenen/silinen/taşınan route'lar;
- değişen backend endpoint ve config key'leri;
- auth, validation, cache ve error koşulları;
- ters dependency/impact yüzeyi;
- package değişikliğinin repositoryler arası dependency graph etkisi.

### Adım 5 — Evaluation suite'i yeni SHA'ya taşıyın

İlgili `config/context-engine-eval.*.json` dosyasını açın.

1. Değişen davranış mevcut bir `strictFact`, soru, plan veya `expectedEvidence` alanını etkiliyorsa önce bunları yeni source gerçeğine göre güncelleyin.
2. Dosya/route rename olduysa eski evidence path'lerini düzeltin.
3. Yeni bir regression veya geliştirici sorusu ortaya çıktıysa, vaka sayısı politika aralığında kalacak şekilde en düşük değerli vakayı değiştirin veya yeni vaka ekleyin.
4. En son `targetSha` değerini gerçekten sync edilen yeni 40 karakterlik HEAD SHA ile değiştirin.

Davranış değişmedi diye yalnız SHA'yı güncellemek mümkündür; ancak bunu source diff'i kontrol ettikten sonra yapın. `targetSha`, “bu suite bu commit üzerinde doğrulandı” demektir.

### Adım 6 — Repository sağlık kontrollerini çalıştırın

```bash
pnpm memory freshness company.web.next
pnpm memory quality company.web.next
pnpm memory security-audit company.web.next
pnpm memory embedding-status
```

Embedding coverage düşükse:

```bash
pnpm memory vectors company.web.next
pnpm memory embedding-status
```

### Adım 7 — Fleet gate'i yeniden çalıştırın

```bash
pnpm eval:fleet:validate
pnpm eval:fleet
```

Fleet evaluation sırasında bütün kayıtlı hedef repository'lerin clean olması gerekir. Başka bir developer checkout'u dirty ise ilgili projeyi commit/stash/revert etmeden gate geçmez.

Bu güncelleme aynı zamanda yeni bir `2 → 4 → 8 → 16` rollout dalgasıysa ve gerekli local evaluation/economy artifact'leri hazırlanmışsa ayrıca çalıştırın:

```bash
pnpm memory rollout-status
```

### Adım 8 — Suite değişikliğini commit edin

Yeni `targetSha`, güncellenen facts/evidence ve eklenen regression vakaları Frontend Engineering Memory repository'sinde commitlenmelidir. SQLite dosyası commitlenmez; başka makine aynı kaynak repositoryleri kendi registry yollarıyla yeniden sync eder.

## 5. Birden fazla proje güncellendiğinde

Bütün hedef checkout'lar doğru branch ve clean durumdaysa:

```bash
pnpm memory sync-all
```

`sync-all` repository hatalarını birbirinden izole eder: başarılı projeleri günceller, başarısızları `ok:false` ile raporlar ve en az bir hata varsa exit code `1` döndürür. Bu durumda:

1. `ok:false` repository'nin hatasını çözün.
2. O repository için `pnpm memory sync company.web.next` çalıştırın.
3. Değişen her repository'nin suite `targetSha` ve source gerçeklerini güncelleyin.
4. `pnpm eval:fleet` ile filonun tamamını doğrulayın.

`sync-all` sonucundaki bir hata, başarılı repositorylerin geri alındığı anlamına gelmez.

## 6. Soru kalitesini zamanla güncelleme

Agent yanlış, stale veya source gerektiren cevap verdiğinde feedback kaydedin:

```bash
pnpm memory feedback add company.web.next --signal=wrong --query="gerçek geliştirici sorusu" --note="beklenen davranış"
pnpm memory feedback backlog company.web.next
pnpm memory feedback triage QUERY_HASH --signal=wrong --state=triaged
```

Triaged kayıtları taslağa dönüştürmek için:

```bash
pnpm memory feedback export company.web.next --state=triaged
```

Feedback otomatik olarak golden truth olmaz. Soruyu, strict fact'i ve evidence'ı source üzerinden doğrulayıp mevcut suite'e regression vakası olarak ekleyin. Vaka sayısı üst sınıra geldiyse tekrar eden veya düşük değerli bir vakayı çıkarın.

Embedding modeli, analyzer veya ranking yalnız tekrarlanabilir fleet miss'i varsa değiştirilmelidir. Tek bir kötü cevap önce query alias, eksik fact, yanlış intent, graph ilişkisi ve agent policy sınıfları açısından incelenmelidir.

## 7. Hızlı kontrol listeleri

### Yeni proje tamamlandı mı?

- [ ] Hedef repository doğru branch'te ve clean.
- [ ] `config/repositories.json` kaydı doğru mutlak yolu kullanıyor.
- [ ] `pnpm memory full` başarılı.
- [ ] Route, dependency, quality, freshness, embedding ve security çıktıları kontrol edildi.
- [ ] Doğru mimari aile seçildi.
- [ ] 5–7 gerçek overlay sorusu source üzerinden curate edildi.
- [ ] `draft:false`, `targetSha` doğru ve `TODO` kalmadı.
- [ ] Fleet manifest kaydı eklendi.
- [ ] `pnpm eval:fleet:validate` başarılı.
- [ ] `pnpm eval:fleet` sonucu `pass`.
- [ ] Agent smoke soruları repository, SHA ve evidence ile cevaplandı.
- [ ] Suite ve manifest commitlendi; yerel DB/registry commitlenmedi.

### Proje güncellemesi tamamlandı mı?

- [ ] Yeni hedef commit clean.
- [ ] Eski indexed SHA not edildi.
- [ ] `pnpm memory sync <repository>` başarılı.
- [ ] Behavior diff ve etkilenmiş route/dependency yüzeyi kontrol edildi.
- [ ] Suite facts/evidence gerekirse güncellendi.
- [ ] Suite `targetSha` yeni indexed SHA oldu.
- [ ] Freshness, quality ve security kontrolleri başarılı.
- [ ] `pnpm eval:fleet` sonucu `pass`.
- [ ] Suite değişiklikleri commitlendi.

## 8. Sık karşılaşılan durumlar

### `Repository working tree must be clean before indexing`

Hedef repository'de uncommitted değişiklik vardır. Engine bu değişikliği bir commit'e bağlayamadığı için bilerek durur. Hedef repository'de commit, stash veya revert yapın; sonra yeniden sync edin.

### `registered repository has no evaluation assignment`

Proje yerel registry'ye eklenmiş fakat `config/evaluation-fleet.json` içine suite ataması yapılmamıştır. Onboarding sırasında geçici olarak beklenir; production gate öncesinde overlay'i curate edip manifest kaydını ekleyin.

### Fleet `target-sha` check'i başarısız

Suite'in `targetSha` değeri, repository HEAD veya indexed SHA ile eşleşmiyordur. Doğru çözüm source değişikliğini incelemek, suite'i güncellemek ve yeni SHA üzerinde tekrar evaluation çalıştırmaktır.

### `sync` sonucu `NOOP`

Repository HEAD'i son indexed SHA ile aynıdır. Bu bir hata değildir.

### MCP eski sonuç gösteriyor

Önce `pnpm memory status` ve `pnpm memory freshness company.web.next` ile database'i kontrol edin. Engine kodu/tool schema değiştiyse `pnpm build` çalıştırıp MCP client sürecini yeniden başlatın. Yalnız data sync yapıldıysa normalde rebuild gerekmez.
