import { createHash } from "node:crypto";

export interface EmbeddingProfile {
  id:string;
  model:string;
  revision:string;
  dimension:number;
  dtype:"q8"|"fp16"|"fp32";
  queryPrefix:string;
  passagePrefix:string;
  vectorTable:string;
  /** Only the original default profile may adopt the pre-profile vector table. */
  legacyVectorTable:string|null;
}

interface ProfileDefinition extends Omit<EmbeddingProfile,"vectorTable"|"legacyVectorTable"> {
  legacyVectorTable?:string;
}

const PROFILES:Record<string,ProfileDefinition>={
  "gte-multilingual-base-v1":{
    id:"gte-multilingual-base-v1",
    model:"onnx-community/gte-multilingual-base",
    // Pin the verified ONNX conversion: a moving model revision would make
    // stored vectors impossible to reproduce across 16 repositories.
    revision:"2edbf5e672aab465f9ed4c154a8b61791c082c69",
    dimension:768,
    dtype:"q8",
    queryPrefix:"Represent this sentence for searching relevant passages: ",
    passagePrefix:"",
  },
  "multilingual-e5-small-v1":{
    id:"multilingual-e5-small-v1",
    model:"Xenova/multilingual-e5-small",
    revision:"761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    dimension:384,
    dtype:"q8",
    queryPrefix:"query: ",
    passagePrefix:"passage: ",
    legacyVectorTable:"memory_vectors_v2",
  },
  "multilingual-e5-base-v1":{
    id:"multilingual-e5-base-v1",
    model:"Xenova/multilingual-e5-base",
    revision:"1ec9243030a27d1a115d5c340572074c125b58b2",
    dimension:768,
    dtype:"q8",
    queryPrefix:"query: ",
    passagePrefix:"passage: ",
  },
};

// The larger 768-dimension candidates tied this profile on the repository
// evaluation while doubling vector size. Keep the measured winner-by-cost as
// production default; larger profiles remain available for future re-evaluation.
export const DEFAULT_EMBEDDING_PROFILE="multilingual-e5-small-v1";

function positiveInteger(value:string|undefined,label:string):number {
  const parsed=Number(value);
  if (!Number.isInteger(parsed)||parsed<=0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function vectorTable(definition:ProfileDefinition):string {
  const fingerprint=createHash("sha256").update(JSON.stringify({
    model:definition.model,revision:definition.revision,dimension:definition.dimension,
    dtype:definition.dtype,queryPrefix:definition.queryPrefix,passagePrefix:definition.passagePrefix,
  })).digest("hex").slice(0,16);
  return `memory_vectors_v3_${fingerprint}`;
}

/**
 * Resolve one immutable embedding contract.
 *
 * Known profiles are the production path. A custom model remains possible for
 * experiments, but its dimension and prefixes must be explicit so it can never
 * be mistaken for vectors produced by another model.
 */
export function resolveEmbeddingProfile(env:NodeJS.ProcessEnv=process.env):EmbeddingProfile {
  const requestedId=env.MEMORY_EMBEDDING_PROFILE;
  const requestedModel=env.MEMORY_EMBEDDING_MODEL;
  let definition:ProfileDefinition|undefined;

  if (requestedId) {
    definition=PROFILES[requestedId];
    if (!definition) throw new Error(`Unknown MEMORY_EMBEDDING_PROFILE: ${requestedId}`);
    if (requestedModel&&requestedModel!==definition.model) {
      throw new Error(`MEMORY_EMBEDDING_MODEL conflicts with profile ${requestedId}`);
    }
  } else if (requestedModel) {
    definition=Object.values(PROFILES).find((item)=>item.model===requestedModel);
    if (!definition) {
      definition={
        id:`custom:${requestedModel}`,
        model:requestedModel,
        revision:env.MEMORY_EMBEDDING_REVISION ?? "main",
        dimension:positiveInteger(env.MEMORY_EMBEDDING_DIMENSION,"MEMORY_EMBEDDING_DIMENSION"),
        dtype:(env.MEMORY_EMBEDDING_DTYPE as ProfileDefinition["dtype"]|undefined) ?? "q8",
        queryPrefix:env.MEMORY_EMBEDDING_QUERY_PREFIX ?? "",
        passagePrefix:env.MEMORY_EMBEDDING_PASSAGE_PREFIX ?? "",
      };
    }
  } else definition=PROFILES[DEFAULT_EMBEDDING_PROFILE];

  if (!definition) throw new Error(`Embedding profile unavailable: ${requestedId ?? DEFAULT_EMBEDDING_PROFILE}`);
  if (!(["q8","fp16","fp32"] as string[]).includes(definition.dtype)) {
    throw new Error(`Unsupported embedding dtype: ${definition.dtype}`);
  }
  return {...definition,vectorTable:vectorTable(definition),legacyVectorTable:definition.legacyVectorTable ?? null};
}

export function knownEmbeddingProfiles():EmbeddingProfile[] {
  return Object.values(PROFILES).map((definition)=>({
    ...definition,vectorTable:vectorTable(definition),legacyVectorTable:definition.legacyVectorTable ?? null,
  }));
}
