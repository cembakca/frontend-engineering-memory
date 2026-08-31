# Embedding model decision

## Production default

The default profile is `multilingual-e5-small-v1`:

- model: `Xenova/multilingual-e5-small`
- revision: `761b726dd34fb83930e26aab4e9ac3899aa1fa78`
- dimension: 384
- dtype: q8
- prefixes: `query: ` and `passage: `

The profile—not the model name alone—is the vector identity. A change to revision, dimension, dtype, or prefixes creates a different fingerprinted `sqlite-vec` table, so incompatible vectors cannot mix silently.

## Measured comparison

The profiles were compared on the same 802 facts and 15-case task-level suite:

| Profile | Dimension | Mean evidence recall | Clean cases | Result |
| --- | ---: | ---: | ---: | --- |
| `multilingual-e5-small-v1` | 384 | 0.9115 | 11/15 | Lowest storage and indexing cost |
| `multilingual-e5-base-v1` | 768 | 0.9115 | 11/15 | No measured quality gain; 2× vector width |
| `gte-multilingual-base-v1` | 768 | 0.9115 | 11/15 | No measured quality gain; 2× vector width |
| embeddings disabled | — | 0.9346 | 12/15 | Demonstrated that remaining misses were analyzer/graph issues |

After analyzer, symbol evidence, and task-seed corrections, the selected E5-small profile reached 0.9231 mean evidence recall with 15/15 clean cases and 7/7 strict cases.

Larger models therefore remain experimental. Doubling vector width across a 16-repository fleet is not justified without a repeatable task-level gain.

## Usage

```bash
MEMORY_EMBEDDING_PROFILE=multilingual-e5-small-v1 pnpm memory vectors
pnpm memory embedding-status
```

To run a controlled comparison, use a separate database, select one of the included experimental profiles, rebuild vectors, and compare `context-eval` plus `context-economy`. Do not migrate the production profile based on generic embedding benchmarks alone.

References:

- [Multilingual E5](https://huggingface.co/intfloat/multilingual-e5-base)
- [GTE multilingual base](https://huggingface.co/Alibaba-NLP/gte-multilingual-base)
- [Transformers.js](https://huggingface.co/docs/transformers.js/pipelines)
