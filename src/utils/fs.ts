import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export async function readTextIfSmall(filePath: string, maxBytes = 512_000): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > maxBytes) return null;
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function readJson<T>(filePath: string): Promise<T | null> {
  const text = await readTextIfSmall(filePath, 2_000_000);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

export function lineNumberAt(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split("\n").length;
}
