import { readFile,writeFile } from "node:fs/promises";
import path from "node:path";
import { getRepositoryConfig,projectRoot } from "../config.js";
import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import { runEvaluationFleet,scaffoldEvaluationOverlay,type EvaluationFleetManifest } from "../retrieval/evaluation-fleet.js";
import { fullIndex } from "../sync/sync.js";

export type ArchitectureFamily="content-site"|"product-app";

function jsonArray(value:unknown):string[] {
  try { return typeof value==="string" ? JSON.parse(value) : []; } catch { return []; }
}

export function inferArchitectureFamily(memoryDb:MemoryDatabase,repository:string):{family:ArchitectureFamily;signals:string[]} {
  const store=new MemoryStore(memoryDb);
  const routes=store.listRoutes(repository) as any[];
  const dependencyRows=memoryDb.db.prepare(`SELECT rpd.package_name FROM repository_package_dependencies rpd
    JOIN repositories repo ON repo.id=rpd.repository_id WHERE repo.name=?`).all(repository) as Array<{package_name:string}>;
  const packages=dependencyRows.map((item)=>item.package_name.toLowerCase());
  const signals:string[]=[];
  const productPackages=packages.filter((item)=>/(?:@tanstack\/react-query|react-query|redux|zustand|formik|react-hook-form|next-auth|@auth\/|auth0)/.test(item));
  if (productPackages.length) signals.push(`product packages: ${productPackages.join(", ")}`);
  const apiRoutes=routes.filter((item)=>item.route_type==="api"||item.route_type==="route-handler").length;
  const authRoutes=routes.filter((item)=>item.auth_required===1||/auth|login|token|session/i.test(item.route)).length;
  const dataRoutes=routes.filter((item)=>jsonArray(item.data_sources_json).length||jsonArray(item.backend_dependencies_json).length).length;
  if (apiRoutes>=3) signals.push(`${apiRoutes} API/route handlers`);
  if (authRoutes>=2) signals.push(`${authRoutes} auth-related routes`);
  if (dataRoutes>=5) signals.push(`${dataRoutes} data-backed routes`);
  const broadProductSurface=routes.length>=20&&apiRoutes>=3&&(authRoutes>=2||dataRoutes>=5);
  return {family:productPackages.length>0||broadProductSurface?"product-app":"content-site",
    signals:signals.length?signals:["content-led route surface"]};
}

function safeName(repository:string):string {
  return repository.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
}

async function writeJson(file:string,value:unknown):Promise<void> {
  await writeFile(file,`${JSON.stringify(value,null,2)}\n`,"utf8");
}

/** Registry is the only hand-authored input; all fleet artifacts are derived. */
export async function onboardRepository(memoryDb:MemoryDatabase,repository:string,options:{evaluate?:boolean}={}):Promise<any> {
  const config=await getRepositoryConfig(repository);
  const index=await fullIndex(config,memoryDb);
  const classification=inferArchitectureFamily(memoryDb,repository);
  const manifestFile=path.join(projectRoot(),"config/evaluation-fleet.json");
  const manifest=JSON.parse(await readFile(manifestFile,"utf8")) as EvaluationFleetManifest;
  const existing=manifest.repositories.find((item)=>item.repository===repository);
  const role=existing?.role ?? "overlay";
  const family=existing?.family ?? classification.family;
  const generatedName=`context-engine-eval.auto.${safeName(repository)}.json`;
  const generatedAssignment=!existing||existing.suite===generatedName;
  const suiteName=existing?.suite ?? generatedName;
  if (generatedAssignment) {
    const suite=scaffoldEvaluationOverlay(memoryDb,repository,family,{generated:true,role});
    await writeJson(path.join(path.dirname(manifestFile),suiteName),suite);
    if (existing) Object.assign(existing,{family,role,suite:suiteName});
    else manifest.repositories.push({repository,family,role,suite:suiteName});
    await writeJson(manifestFile,manifest);
  }
  const fleet=await runEvaluationFleet(memoryDb,manifestFile,{validateOnly:!options.evaluate});
  return {repository,index,classification,suite:suiteName,suiteMode:generatedAssignment?"generated":"curated-preserved",fleet};
}
