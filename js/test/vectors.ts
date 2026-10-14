import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPEC_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "spec",
  "test-vectors",
);

export interface Vector<T = Record<string, unknown>> {
  name: string;
  layer: string;
  [k: string]: unknown;
  extra?: T;
}

export function loadVectors(layer: string): Record<string, any>[] {
  const dir = join(SPEC_ROOT, layer);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
}