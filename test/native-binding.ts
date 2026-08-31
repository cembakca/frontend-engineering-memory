import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// Native addons can remain blocked by macOS file-provider/quarantine handling when
// a project is opened directly from an extracted archive. Copying the test binding
// to the OS temp directory avoids that host-only condition. Production installs use
// better-sqlite3's normal resolver unless MEMORY_SQLITE_NATIVE_BINDING is explicit.
export async function configureTestNativeBinding(): Promise<void> {
  if (process.env.MEMORY_SQLITE_NATIVE_BINDING || process.platform !== "darwin") return;
  const localRequire=createRequire(import.meta.url);
  const packageEntry=localRequire.resolve("better-sqlite3");
  const packageRoot=path.resolve(path.dirname(packageEntry),"..");
  const source=path.join(packageRoot,"prebuilds",`${process.platform}-${process.arch}.node`);
  const targetDir=path.join(os.tmpdir(),"frontend-engineering-memory-native");
  const target=path.join(targetDir,`better-sqlite3-${process.arch}-${process.pid}.node`);
  await mkdir(targetDir,{recursive:true});
  await copyFile(source,target);
  process.env.MEMORY_SQLITE_NATIVE_BINDING=target;
}
