import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_EMBEDDING_PROFILE, knownEmbeddingProfiles, resolveEmbeddingProfile } from "../src/memory/embedding-profile.js";

test("defaults to the measured production E5-small profile",()=>{
  const profile=resolveEmbeddingProfile({});
  assert.equal(profile.id,DEFAULT_EMBEDDING_PROFILE);
  assert.equal(profile.model,"Xenova/multilingual-e5-small");
  assert.equal(profile.dimension,384);
  assert.equal(profile.dtype,"q8");
  assert.match(profile.revision,/^[0-9a-f]{40}$/);
  assert.match(profile.vectorTable,/^memory_vectors_v3_[0-9a-f]{16}$/);
});

test("keeps E5 and GTE vectors in different immutable tables",()=>{
  const profiles=knownEmbeddingProfiles();
  const gte=profiles.find((item)=>item.id==="gte-multilingual-base-v1");
  const e5=profiles.find((item)=>item.id==="multilingual-e5-small-v1");
  assert.ok(gte&&e5);
  assert.notEqual(gte.vectorTable,e5.vectorTable);
  assert.notEqual(gte.dimension,e5.dimension);
  assert.equal(e5.legacyVectorTable,"memory_vectors_v2");
});

test("requires a complete contract for an experimental custom model",()=>{
  assert.throws(()=>resolveEmbeddingProfile({MEMORY_EMBEDDING_MODEL:"example/custom"}),/MEMORY_EMBEDDING_DIMENSION/);
  const profile=resolveEmbeddingProfile({
    MEMORY_EMBEDDING_MODEL:"example/custom",MEMORY_EMBEDDING_DIMENSION:"256",
    MEMORY_EMBEDDING_QUERY_PREFIX:"search: ",MEMORY_EMBEDDING_REVISION:"abc123",
  });
  assert.equal(profile.dimension,256);
  assert.equal(profile.queryPrefix,"search: ");
  assert.equal(profile.revision,"abc123");
});
