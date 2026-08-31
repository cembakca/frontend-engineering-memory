# RCE-021 — Point-in-time context

Point-in-time sorgusu “şu commit civarı” değil, tam bir başarılı index snapshot'ıdır. Snapshot repository adı + 40 karakter SHA ile tekildir ve index transaction'ıyla birlikte commit edilir veya rollback olur.

```bash
npm run memory -- snapshots repo
npm run memory -- context-at repo --sha=<indexed-sha> "API_URL hangi akışta okunuyor?"
```

MCP'de `memory_context` çağrısına `atSha` eklenir. Engine snapshot içindeki active facts ve graph relations üzerinde lexical hedefleme yapar; en fazla 10 fact ve 30 relation seçer, evidence dosyalarını `answerContract.sourceFallback` altında verir.

Sözleşme sınırları:

- Yalnız RCE-020 ile kaydedilmiş indexed SHA'lar sorgulanır.
- Eski `memories.active` kolonundan tarih tahmini yapılmaz.
- Çalışma ağacının bugünkü graph'ı eski SHA adına kullanılmaz.
- Snapshot yoksa `Indexed snapshot not found` hatası alınır.
- Bu özellik mevcut veritabanına geçmişi uydurmaz; deployment sonrası ilk `full` güncel snapshot'ı, sonraki `sync` işlemleri tarih zincirini oluşturur.

Bu son madde önemli: temporal doğruluk ileriye dönük başlar. Daha önce indekslenmiş fakat snapshot tablosuna yazılmamış SHA'lar yeniden index edilmeden point-in-time görünümü kazanmaz.
