# Embedding model kararı

**Tarih:** 31 Ağustos 2026  
**Kapsam:** Türkçe/İngilizce karma sorgulu, yerel çalışan 16 Next.js repository filosu

## Karar

Üretim varsayılanı `multilingual-e5-small-v1` olarak kalır. Profil şu sözleşmenin tamamını sabitler:

- model: `Xenova/multilingual-e5-small`
- revision: `761b726dd34fb83930e26aab4e9ac3899aa1fa78`
- dimension: 384
- dtype: q8
- query/passage prefix: `query: ` / `passage: `

Model adı tek başına artık vektör kimliği değildir. Revision, boyut, dtype ve prefix değişince yeni fingerprint'li sqlite-vec tablosu kullanılır; farklı modellerin vektörleri sessizce karışamaz.

## Ölçüm

Aynı 802 fact ve aynı 15-vaka context suite'iyle yerel A/B:

| Profil | Boyut | Mean evidence recall | Clean | Gözlem |
| --- | ---: | ---: | ---: | --- |
| `multilingual-e5-small-v1` | 384 | 0,9115 | 11/15 | En düşük depolama/indeks maliyeti |
| `multilingual-e5-base-v1` | 768 | 0,9115 | 11/15 | Kalite artmadı; vektör boyutu 2× |
| `gte-multilingual-base-v1` | 768 | 0,9115 | 11/15 | Kalite artmadı; vektör boyutu 2× |
| embedding kapalı | — | 0,9346 | 12/15 | Eksik fact/graph sorununu embedding çözmüyor |

Bu A/B'nin ardından analyzer, sembol kanıtı ve task-aware seed düzeltmeleri yapıldı. Seçilen E5-small profiliyle temiz nihai koşu 0,9231 recall, 15/15 clean ve 7/7 strict verdi. Bu nedenle daha büyük modeli seçmek ölçülmüş bir kalite kazancı olmadan 16 repository boyunca depolama ve yeniden-indeks maliyetini ikiye katlayacaktı.

## Kullanım

```bash
MEMORY_EMBEDDING_PROFILE=multilingual-e5-small-v1 pnpm memory vectors
pnpm memory embedding-status
```

Kontrollü tekrar deney için `multilingual-e5-base-v1` ve `gte-multilingual-base-v1` profilleri kodda tutulur. Profil değişimi önce ayrı DB üzerinde `context-eval` + `context-economy` ile ölçülmeli, ardından tüm vektörler `vectors` komutuyla yeniden kurulmalıdır.

## Kaynaklar

- E5 multilingual model ailesi: <https://huggingface.co/intfloat/multilingual-e5-base>
- GTE multilingual base: <https://huggingface.co/Alibaba-NLP/gte-multilingual-base>
- Transformers.js pipeline/model yükleme: <https://huggingface.co/docs/transformers.js/pipelines>
