import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { matchingAliasRoute, matchingQueryAliases, normalizeQueryAliases } from "../src/retrieval/query-vocabulary.js";
import { hybridSearch } from "../src/retrieval/search.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

test("repository vocabulary groups expand either side of a product alias",()=>{
  const groups=normalizeQueryAliases({"iletişim formu":["ContactForm","contact"]});
  assert.deepEqual(matchingQueryAliases("İletişim formu nasıl gönderiliyor?",[groups]),
    ["iletişim formu","ContactForm","contact"]);
  assert.deepEqual(matchingQueryAliases("ContactForm nerede?",[groups]),
    ["iletişim formu","ContactForm","contact"]);
  assert.deepEqual(matchingQueryAliases("Menü nerede?",[groups]),[]);
});

test("maps a product alias to an indexed static route",()=>{
  const groups=normalizeQueryAliases({"faizsiz fırsatlar":["interest-free-deals"]});
  assert.equal(matchingAliasRoute("Faizsiz fırsatlar verisi nereden gelir?",[groups],
    ["/","/interest-free-deals","/interest-free-deals/[slug]"]),"/interest-free-deals");
});

test("rejects malformed repository vocabulary",()=>{
  assert.throws(()=>normalizeQueryAliases({contact:"not-an-array"}),/must be an array/);
  assert.throws(()=>normalizeQueryAliases({x:["contact"]}),/Invalid queryAliases key/);
});

test("hybrid FTS uses aliases stored with the repository",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-query-alias-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    memoryDb.db.prepare(
      "INSERT INTO repositories(name,path,query_aliases_json,last_indexed_sha) VALUES(?,?,?,?)",
    ).run("fixture",root,JSON.stringify({"iletişim formu":["ContactForm"]}),"a".repeat(40));
    const inserted=memoryDb.db.prepare(
      "INSERT INTO memories(repository_id,memory_type,subject,content,confidence,created_sha,updated_sha) VALUES(1,'module_contract','ContactForm','ContactForm submits the payload.','verified',?,?)",
    ).run("a".repeat(40),"a".repeat(40));
    memoryDb.db.prepare(
      "INSERT INTO memory_fts(memory_id,repository_id,memory_type,subject,content) VALUES(?,1,'module_contract','ContactForm','ContactForm submits the payload.')",
    ).run(Number(inserted.lastInsertRowid));

    const results=await hybridSearch(memoryDb,"İletişim formu nasıl gönderiliyor?",{repo:"fixture"});
    assert.equal(results[0]?.subject,"ContactForm");
    assert.ok(results[0]?.channels.includes("fts"));
  } finally {
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
  }
});
