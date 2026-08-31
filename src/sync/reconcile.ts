import { getRepositoryConfig, loadRegistry } from "../config.js";
import type { MemoryDatabase } from "../memory/database.js";
import { fullIndex } from "./sync.js";

export async function reconcileAll(memoryDb:MemoryDatabase):Promise<any[]> {
  const registry=await loadRegistry();
  const results:any[]=[];
  for (const item of registry.repositories) {
    try {
      const config=await getRepositoryConfig(item.name);
      results.push({repository:item.name,ok:true,result:await fullIndex(config,memoryDb)});
    } catch(error) {
      results.push({repository:item.name,ok:false,error:(error as Error).message});
    }
  }
  return results;
}

export function startReconciliationScheduler(
  memoryDb:MemoryDatabase,
  enqueue:<T>(job:()=>Promise<T>)=>Promise<T>,
):()=>void {
  const minutes=Number(process.env.MEMORY_RECONCILE_INTERVAL_MINUTES ?? 0);
  if (!Number.isFinite(minutes) || minutes<=0) return ()=>undefined;
  const milliseconds=Math.max(60_000,minutes*60_000);
  const timer=setInterval(()=>{
    void enqueue(()=>reconcileAll(memoryDb)).then(
      (results)=>console.error(`[memory] scheduled reconciliation completed: ${JSON.stringify(results)}`),
      (error)=>console.error(`[memory] scheduled reconciliation failed: ${(error as Error).message}`),
    );
  },milliseconds);
  timer.unref();
  console.error(`[memory] scheduled reconciliation enabled every ${minutes} minute(s)`);
  return ()=>clearInterval(timer);
}
