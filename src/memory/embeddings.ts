import type { EmbeddingProvider } from "./providers.js";

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly dimension=384;
  private extractorPromise:Promise<any>|null=null;

  constructor(private readonly model=process.env.MEMORY_EMBEDDING_MODEL ?? "Xenova/multilingual-e5-small") {}

  private async extractor():Promise<any> {
    if (!this.extractorPromise) {
      this.extractorPromise=import("@huggingface/transformers").then(({pipeline})=>pipeline("feature-extraction",this.model));
    }
    return this.extractorPromise;
  }

  private async embed(texts:string[]):Promise<Float32Array[]> {
    if (!texts.length) return [];
    const model=await this.extractor();
    const output=await model(texts,{pooling:"mean",normalize:true});
    return (output.tolist() as number[][]).map((row)=>Float32Array.from(row));
  }

  embedPassages(texts:string[]):Promise<Float32Array[]> { return this.embed(texts.map((text)=>`passage: ${text}`)); }
  async embedQuery(text:string):Promise<Float32Array> {
    const [vector]=await this.embed([`query: ${text}`]);
    if (!vector) throw new Error("Embedding model returned no query vector");
    return vector;
  }
}

let defaultProvider:EmbeddingProvider|null=null;
export function embeddingProvider():EmbeddingProvider {
  defaultProvider ??= new TransformersEmbeddingProvider();
  return defaultProvider;
}
export function embedPassages(texts:string[]):Promise<Float32Array[]> { return embeddingProvider().embedPassages(texts); }
export function embedQuery(text:string):Promise<Float32Array> { return embeddingProvider().embedQuery(text); }
