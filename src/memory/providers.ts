export interface EmbeddingProvider {
  readonly dimension:number;
  embedPassages(texts:string[]):Promise<Float32Array[]>;
  embedQuery(text:string):Promise<Float32Array>;
}

export interface VectorSearchOptions {
  repositoryId?:number;
  memoryTypes?:string[];
  limit:number;
}

export interface VectorMatch {
  id:number;
  distance:number;
}

export interface VectorStore {
  readonly dimension:number;
  set(memoryId:number,vector:Float32Array,metadata:{repositoryId:number;memoryType:string}):void;
  delete(memoryId:number):void;
  has(memoryId:number):boolean;
  count(options?:Omit<VectorSearchOptions,"limit">):number;
  search(vector:Float32Array,options:VectorSearchOptions):VectorMatch[];
}
