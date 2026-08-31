# Next.js fleet onboarding runbook

Bu çalışma alanı App Router, Pages Router ve hybrid Next.js repository'lerini aynı merkezi veritabanında, repository kimliğiyle izole ederek indeksler. Hedef filo 16 repository'dir; rollout dalgaları `2 → 4 → 8 → 16` şeklindedir.

## Repository önkoşulları

Her kayıt için benzersiz `name`, erişilebilir Git çalışma ağacı, `package.json` içinde Next.js bağımlılığı ve doğru ana branch gerekir. Geliştirici checkout'larında `managedCheckout:false` kullanılır; merkez servisin kendine ait temiz clone'larında `managedCheckout:true` kullanılabilir.

```json
{
  "name": "hangikredi.example.fe.next",
  "path": "/srv/frontend-memory/repos/hangikredi.example.fe.next",
  "mainBranch": "main",
  "managedCheckout": true,
  "remote": "origin"
}
```

Kirli çalışma ağacı indekslenmez veya resetlenmez. Bu, geliştirici değişikliklerinin yanlış snapshot altında hafızaya girmesini engeller.

## Her dalgada

1. Yeni repository kayıtlarını `config/repositories.json` içine ekle.
2. Her yeni şekilden bir repository'yi tek başına indeksle: `pnpm memory full <repository>`.
3. Dalga indeksini çalıştır: `pnpm memory full-all`.
4. `pnpm memory embedding-status` ile her repository için vector/evidence coverage'ı kontrol et.
5. `pnpm memory security-audit` ve `pnpm memory rollout-status` çalıştır.
6. `advance` olmadan sonraki dalgaya geçme; yapılandırılmış soak süresini tamamla.

Günlük işletim:

```bash
pnpm memory sync-all
pnpm memory freshness
pnpm memory rollout-status
```

Drift koruması için periyodik `reconcile-all` kullanılabilir. Bir repository başarısız olursa diğerlerinin sonuçları korunur, batch raporunda repository bazında hata görünür ve CLI sıfırdan farklı çıkış kodu verir.

## Kabul tabanı

- freshness: `fresh` veya `tree-dirty`
- güvenlik ihlali: 0
- duplication ratio: en fazla 0,05
- evidence coverage: en az 0,95
- repo başına DB: en fazla 50 MB
- retrieval p95: en fazla 5 saniye

Nihai iki-repository ölçümü 6,27 MB/repository ve p95 3,367 saniyedir. Bu, 16 repository için doğrusal ölçek varsayımına yeterli başlangıç marjı verir; gerçek maliyet her dalgada tekrar ölçülür, tahmin başarı sayılmaz.

## Sınır

“Her Next.js projesi” runtime davranışının eksiksiz simülasyonu anlamına gelmez. Motor statik, kanıt-temelli analiz yapar; custom compiler/plugin davranışı, runtime-generated route'lar ve dış servislerin gerçek davranışı bilinmiyorsa answer contract açıkça kaynak fallback'i ister. Yeni bir mimari şekil ilk kez görülüyorsa o repository için gerçek görev soruları evaluation suite'ine eklenmeden filo geneline genellenmez.
