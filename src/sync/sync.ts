import path from "node:path";
import { access } from "node:fs/promises";
import {
  analyzeProjectFile, analyzeRepositoryDependencies, analyzeRepositoryProfile, analyzeSourceFile,
  canonicalizeMemories, dependencyMemories, listAnalyzableSourceFiles, listProjectAnalysisFiles, repositoryProfileMemory,
  routeMemory, scanRoutes,
} from "../analyzers/index.js";
import { assertRepositorySnapshot, changedFiles, isAncestor, isGitRepository, refreshManagedCheckout } from "../git/git.js";
import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import { persistVectors, prepareVectors } from "../memory/vectorize.js";
import type { MemoryCandidate, PreparedMemoryCandidate, RepositoryConfig, RouteRecord, SyncOptions } from "../types.js";
import { classifyFile } from "./classifier.js";
import { extractSymbolGraph } from "../analyzers/symbol-graph.js";

const SOURCE_EXT=/\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

async function exists(file:string):Promise<boolean> { try { await access(file); return true; } catch { return false; } }

async function baseline(config:RepositoryConfig,memoryDb:MemoryDatabase,options:SyncOptions) {
  if (!(await isGitRepository(config.path))) throw new Error(`Not a Git repository: ${config.path}`);
  const mainBranch=config.mainBranch ?? "main";
  if (config.managedCheckout) await refreshManagedCheckout(config.path,mainBranch,config.remote ?? "origin");
  const head=await assertRepositorySnapshot(config.path,mainBranch,options.expectedCommit);
  const profile=await analyzeRepositoryProfile(config.name,config.path);
  const store=new MemoryStore(memoryDb);
  const existing=store.getRepository(config.name) as {id:number;last_indexed_sha?:string|null}|undefined;
  return {head,profile,store,existing};
}

function routeKey(route:Pick<RouteRecord,"route"|"sourceFile">):string { return `${route.route}\0${route.sourceFile}`; }

export async function fullIndex(config:RepositoryConfig,memoryDb:MemoryDatabase,options:SyncOptions={}):Promise<object> {
  const {head,profile,store,existing}=await baseline(config,memoryDb,options);
  const routes=await scanRoutes(config.path);
  const dependencies=await analyzeRepositoryDependencies(config.path);
  const sourceFiles=await listAnalyzableSourceFiles(config.path);
  const graph=await extractSymbolGraph(config.path,sourceFiles,routes.map((route)=>route.route));
  const projectFiles=await listProjectAnalysisFiles(config.path);
  const candidates:MemoryCandidate[]=[repositoryProfileMemory(profile),...routes.map(routeMemory),...dependencyMemories(dependencies)];
  for (const file of sourceFiles) candidates.push(...await analyzeSourceFile(config.path,file));
  for (const file of projectFiles) candidates.push(...await analyzeProjectFile(config.path,file));
  const prepared=await store.prepareMemories(config.path,canonicalizeMemories(candidates));
  const partition=existing ? store.partitionPreparedMemories(existing.id,prepared) : {reused:[],fresh:prepared};
  const preservedAiIds=existing ? await store.validActiveAiMemoryIds(existing.id,config.path) : new Set<number>();
  const missingReused=store.vectorEnabled ? partition.reused.filter((item)=>!memoryDb.vectorStore?.has(item.id)) : [];
  const vectorRows=[...partition.fresh,...missingReused.map((item)=>item.row)];
  const vectors=await prepareVectors(memoryDb,vectorRows);

  let deactivated=0; let created=0;
  store.transaction(()=>{
    const repositoryId=store.upsertRepository(config,profile);
    const previous=store.getRepository(config.name) as {last_indexed_sha?:string|null};
    const runId=store.beginRun(repositoryId,"FULL",previous.last_indexed_sha ?? null,head);
    const reusedIds=new Set([...partition.reused.map((item)=>item.id),...preservedAiIds]);
    store.reconcileRoutes(repositoryId,routes,head);
    store.replaceDependencies(repositoryId,dependencies,head);
    store.replaceRouteDependencies(repositoryId,routes,head);
    deactivated=store.deactivateRepositoryMemories(repositoryId,head,runId,reusedIds);
    const ids=store.insertPreparedMemories(repositoryId,partition.fresh,head,runId);
    persistVectors(store,[...ids,...missingReused.map((item)=>item.id)],vectors);
    store.recordReusedMemories(runId,partition.reused);
    created=ids.length;
    store.captureRepositorySnapshot(repositoryId,config.name,head,profile as any,graph);
    store.setLastIndexed(repositoryId,head);
    store.finishRun(runId,{changedFiles:sourceFiles.length+projectFiles.length,memoriesCreated:created,memoriesDeleted:deactivated});
  });
  return {type:"FULL",repository:config.name,sha:head,filesScanned:sourceFiles.length+projectFiles.length,routes:routes.length,routeDependencies:routes.reduce((sum,route)=>sum+route.dependencies.length,0),memoriesCreated:created,memoriesReused:partition.reused.length,aiMemoriesPreserved:preservedAiIds.size,memoriesDeactivated:deactivated};
}

export async function incrementalSync(config:RepositoryConfig,memoryDb:MemoryDatabase,options:SyncOptions={}):Promise<object> {
  const {head,profile,store,existing}=await baseline(config,memoryDb,options);
  const fromSha=existing?.last_indexed_sha ?? null;
  if (!existing || !fromSha) return fullIndex(config,memoryDb,options);
  const repositoryId=existing.id;
  if (fromSha===head) {
    const routes=await scanRoutes(config.path);
    const sourceFiles=await listAnalyzableSourceFiles(config.path);
    const graph=await extractSymbolGraph(config.path,sourceFiles,routes.map((route)=>route.route));
    store.transaction(()=>{
      store.reconcileRoutes(repositoryId,routes,head);
      store.captureRepositorySnapshot(repositoryId,config.name,head,profile as any,graph);
    });
    return {type:"NOOP",repository:config.name,sha:head,routes:routes.length,changedFiles:0};
  }
  if (!(await isAncestor(config.path,fromSha,head))) {
    const result=await fullIndex(config,memoryDb,options) as Record<string,unknown>;
    return {...result,reason:"last_indexed_sha is not an ancestor of HEAD; performed a safe full index"};
  }

  const changes=await changedFiles(config.path,fromSha,head);
  const classified=changes.map((change)=>({...change,classification:classifyFile(change.path)}));
  const relevant=classified.filter((change)=>change.classification.memoryRelevant);
  const routes=await scanRoutes(config.path);
  const snapshotFiles=await listAnalyzableSourceFiles(config.path);
  const graph=await extractSymbolGraph(config.path,snapshotFiles,routes.map((route)=>route.route));
  const changedPaths=new Set(changes.flatMap((change)=>change.previousPath ? [change.previousPath,change.path] : [change.path]));
  const affectedRouteKeys=store.routeKeysAffectedByFiles(repositoryId,changedPaths);
  for (const route of routes) if (route.behaviorFiles.some((file)=>changedPaths.has(file)) || changedPaths.has(route.sourceFile)) affectedRouteKeys.add(routeKey(route));
  if (relevant.some((change)=>/(^|\/)(?:middleware|proxy)\.(?:ts|js)$/.test(change.path))) {
    for (const route of routes) affectedRouteKeys.add(routeKey(route));
  }

  const dependencies=relevant.length ? await analyzeRepositoryDependencies(config.path) : null;
  const candidates:MemoryCandidate[]=[];
  if (relevant.some((change)=>change.classification.analyzers.includes("repository"))) candidates.push(repositoryProfileMemory(profile));
  if (dependencies) candidates.push(...dependencyMemories(dependencies));
  for (const change of relevant) {
    if (change.status.startsWith("D") || !(await exists(path.join(config.path,change.path)))) continue;
    if (SOURCE_EXT.test(change.path)) candidates.push(...await analyzeSourceFile(config.path,change.path));
    if (change.classification.analyzers.includes("build") || change.classification.analyzers.includes("configuration")) candidates.push(...await analyzeProjectFile(config.path,change.path));
  }
  const affectedRoutes=routes.filter((route)=>affectedRouteKeys.has(routeKey(route)));
  candidates.push(...affectedRoutes.map(routeMemory));
  const prepared=await store.prepareMemories(config.path,canonicalizeMemories(candidates));
  const partition=store.partitionPreparedMemories(repositoryId,prepared);
  const reusedIds=new Set(partition.reused.map((item)=>item.id));
  const missingReused=store.vectorEnabled ? partition.reused.filter((item)=>!memoryDb.vectorStore?.has(item.id)) : [];
  const vectorRows=[...partition.fresh,...missingReused.map((item)=>item.row)];
  const vectors=await prepareVectors(memoryDb,vectorRows);

  let deactivated=0; let created=0;
  store.transaction(()=>{
    store.upsertRepository(config,profile);
    const runId=store.beginRun(repositoryId,"INCREMENTAL",fromSha,head);
    store.reconcileRoutes(repositoryId,routes,head);
    if (dependencies) {
      store.replaceDependencies(repositoryId,dependencies,head);
      store.replaceRouteDependencies(repositoryId,routes,head);
    }
    for (const change of changes) {
      if (change.previousPath) deactivated+=store.deactivateMemoriesForSource(repositoryId,change.previousPath,head,runId,reusedIds);
      deactivated+=store.deactivateMemoriesForSource(repositoryId,change.path,head,runId,reusedIds);
    }
    for (const key of affectedRouteKeys) {
      const [route,sourceFile]=key.split("\0") as [string,string];
      deactivated+=store.deactivateRouteMemory(repositoryId,route,sourceFile,head,runId,reusedIds);
    }
    const ids=store.insertPreparedMemories(repositoryId,partition.fresh,head,runId);
    persistVectors(store,[...ids,...missingReused.map((item)=>item.id)],vectors);
    store.recordReusedMemories(runId,partition.reused);
    created=ids.length;
    store.captureRepositorySnapshot(repositoryId,config.name,head,profile as any,graph);
    store.setLastIndexed(repositoryId,head);
    store.finishRun(runId,{changedFiles:changes.length,memoriesCreated:created,memoriesDeleted:deactivated});
  });
  return {type:"INCREMENTAL",repository:config.name,fromSha,toSha:head,changedFiles:changes,relevantChanges:relevant.map((change)=>change.classification),routes:routes.length,memoriesCreated:created,memoriesReused:partition.reused.length,memoriesDeactivated:deactivated};
}
