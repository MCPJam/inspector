/** Bootstrap bytes come from the reserved, digest-verified pack, including in Electron. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";

export async function withLocalPackBootstrap(adapter: HarnessAgentAdapter, root: string): Promise<HarnessAgentAdapter> {
  const recipe = JSON.parse(await readFile(join(root, "bootstrap.json"), "utf8")) as Awaited<ReturnType<NonNullable<HarnessAgentAdapter["getBootstrap"]>>>;
  if (!recipe || typeof recipe.bootstrapDir !== "string" || !Array.isArray(recipe.files) || !recipe.files.some(file => file.path === `${recipe.bootstrapDir}/bridge.mjs`)) throw new Error("Verified runtime has no valid bootstrap recipe");
  return { ...adapter, getBootstrap: async () => recipe };
}
