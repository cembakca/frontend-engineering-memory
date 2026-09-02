import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProjectFile, analyzeRouteRewrites, extractRouteRewrites } from "../src/analyzers/project-memory.js";
import { aliasRouteMatch, deriveQueryAliases } from "../src/retrieval/query-vocabulary.js";
import { MemoryDatabase } from "../src/memory/database.js";
import { TaskContextCompiler } from "../src/retrieval/task-context.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

const SHA="b".repeat(40);

const REWRITES_MODULE=`export const rewrites = [
  { source: '/kredi/konut-kredisi', destination: '/loan/housingloan' },
  { source: '/kredi/konut-kredisi/:bank', destination: '/loan/housingloan/[bank]' },
  { source: '/hesaplama-araclari', destination: '/calculationtools' },
  { source: '/eski-sayfa', destination: '/loan/housingloan', permanent: true },
];
`;

/** A repository that keeps its routing rules outside next.config, as many do. */
async function repositoryWithSplitRewrites():Promise<string> {
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-vocabulary-"));
  await mkdir(path.join(root,"src/app/loan/housingloan"),{recursive:true});
  await mkdir(path.join(root,"src/app/calculationtools"),{recursive:true});
  await writeFile(path.join(root,"rewrites.config.ts"),REWRITES_MODULE);
  await writeFile(path.join(root,"next.config.ts"),
    "import { rewrites } from './rewrites.config';\nconst nextConfig = { basePath: '', async rewrites(){ return rewrites; } };\nexport default nextConfig;\n");
  await writeFile(path.join(root,"src/app/loan/housingloan/page.tsx"),"export default function Page(){ return null }\n");
  await writeFile(path.join(root,"src/app/calculationtools/page.tsx"),"export default function Page(){ return null }\n");
  return root;
}

const ROUTES=[
  {route:"/loan/housingloan",sourceFile:"src/app/loan/housingloan/page.tsx"},
  {route:"/calculationtools",sourceFile:"src/app/calculationtools/page.tsx"},
];

test("routing rules are recognised by shape, not by the file that declares them",()=>{
  const rules=extractRouteRewrites("rewrites.config.ts",REWRITES_MODULE);
  assert.equal(rules.length,4);
  // Rule values keep their source text; the vocabulary layer unquotes them.
  assert.deepEqual(rules[0],{kind:"rewrites",source:'"/kredi/konut-kredisi"',destination:'"/loan/housingloan"',
    file:"rewrites.config.ts",line:2});
  // The declaration the rules live under names their kind...
  assert.equal(rules[3]?.kind,"rewrites");
  // ...and where there is no such name, the kind comes from the rule's own shape.
  const anonymous=extractRouteRewrites("routes.config.ts",
    "export default [{ source: '/eski', destination: '/yeni', permanent: true }];\n");
  assert.equal(anonymous[0]?.kind,"redirects");
});

test("a split-out rules module is discovered and indexed like next.config",async()=>{
  const root=await repositoryWithSplitRewrites();
  try {
    // next.config.ts only re-exports the imported list, so every located rule
    // comes from the module that actually declares it.
    const rules=await analyzeRouteRewrites(root);
    assert.deepEqual([...new Set(rules.map((rule)=>rule.file))],["rewrites.config.ts"]);
    assert.equal(rules.length,4);
    const memories=await analyzeProjectFile(root,"rewrites.config.ts");
    assert.ok(memories.some((item)=>item.type==="next_config"&&item.content.includes("konut-kredisi")
      &&item.content.includes("/loan/housingloan")),"the rule keeps both sides of the mapping");
    assert.ok(memories.every((item)=>item.sourceFile==="rewrites.config.ts"&&(item.startLine ?? 0)>0),
      "every rule is located in the file that declares it");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("rules declared inline in a next.config method are read the same way",()=>{
  const inline=`const nextConfig = {
  async redirects() { return [{ source: '/anasayfa', destination: '/', permanent: true }]; },
  async rewrites() { return [{ source: '/kredi/konut-kredisi', destination: '/loan/housingloan' }]; },
};
export default nextConfig;
`;
  const rules=extractRouteRewrites("next.config.mjs",inline);
  assert.deepEqual(rules.map((rule)=>rule.kind),["redirects","rewrites"]);
  const aliases=deriveQueryAliases(ROUTES,{},rules);
  assert.equal(aliasRouteMatch("Konut kredisi sayfası hangi dosyada?",[aliases],ROUTES.map((route)=>route.route))?.route,
    "/loan/housingloan");
});

test("a localized public URL becomes vocabulary for the route it rewrites to",()=>{
  const rules=extractRouteRewrites("rewrites.config.ts",REWRITES_MODULE);
  const aliases=deriveQueryAliases(ROUTES,{},rules);
  const names=ROUTES.map((route)=>route.route);
  assert.equal(aliasRouteMatch("Konut kredisi sayfası hangi dosyadan geliyor?",[aliases],names)?.route,"/loan/housingloan");
  assert.equal(aliasRouteMatch("Hesaplama araçları sayfası hangi route?",[aliases],names)?.route,"/calculationtools");
  // Nothing in the repository connects this wording to a route.
  assert.equal(aliasRouteMatch("Sigorta teklif sayfası nerede?",[aliases],names),undefined);
});

test("path parameters and wildcards are not vocabulary",()=>{
  const aliases=deriveQueryAliases(ROUTES,{},[
    {source:"'/kredi/:type/basvuru'",destination:"'/loan/housingloan'"},
    {source:"'/eski/*'",destination:"'/calculationtools'"},
  ]);
  const terms=Object.values(aliases).flat().join(" ");
  assert.ok(!terms.includes(":type"),terms);
  assert.ok(!terms.includes("*"),terms);
  assert.ok(terms.includes("kredi"),"the static prefix still counts");
});

test("a repository with no curated aliases answers a lookup in its public language",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await repositoryWithSplitRewrites();
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    const aliases=deriveQueryAliases(ROUTES,{},await analyzeRouteRewrites(root));
    memoryDb.db.prepare(
      "INSERT INTO repositories(name,path,framework,next_version,router_type,query_aliases_json,last_indexed_sha) VALUES(?,?,?,?,?,?,?)",
    ).run("fixture",root,"Next.js","16.3.0","app",JSON.stringify(aliases),SHA);
    const insert=memoryDb.db.prepare(
      "INSERT INTO routes(repository_id,route,route_type,router_type,source_file,rendering_mode,server_component,control_flow_json,evidence_json,last_seen_sha,active)"
      +" VALUES(1,?,'page','app',?,'rsc',1,'[]','[]',?,1)");
    for (const route of ROUTES) insert.run(route.route,route.sourceFile,SHA);

    const pack=await new TaskContextCompiler(memoryDb).compile(
      "Konut kredisi sayfası hangi route ve source dosyasındadır?",{repository:"fixture"}) as any;
    assert.equal(pack.route?.route,"/loan/housingloan");
    assert.equal(pack.route?.sourceFile,"src/app/loan/housingloan/page.tsx");
    assert.equal(pack.retrieval.resolvedBy,"registry-vocabulary");
    assert.equal(pack.answerContract.uncertainty.level,"none");
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});
