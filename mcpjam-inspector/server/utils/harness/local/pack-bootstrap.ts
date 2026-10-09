/**
 * The bootstrap recipe a LOCAL session hands the framework.
 *
 * Never the adapter's own recipe as-is: that one installs a vendor graph into
 * a sandbox, and locally the verified runtime already is that graph.
 *
 *  - A harness with an Inspector layer (both, now): the recipe is built from
 *    constants compiled into this build (`inspectorLayerRecipe`) — the layer's
 *    bridge files, so the framework's writes compare equal to the layer copy
 *    by construction, and the adapter's declared directory and commands, which
 *    the translator turns into no-ops. Nothing is read from the pack or from
 *    the adapter package, so a bridge change needs no new pack and Electron
 *    needs no unpacked adapter.
 *  - A runtime whose bridge ships in its pack (`launcherSource: "pack"` — a
 *    pack from before the split, kept resolvable for tests and tools): the
 *    recipe the pack build recorded in `bootstrap.json`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { inspectorLayerRecipe } from "./inspector-layer.js";
import type { ResolvedRuntime } from "./runtime-identity.js";

type BootstrapRecipe = Awaited<ReturnType<NonNullable<HarnessAgentAdapter["getBootstrap"]>>>;

function assertRecipe(recipe: BootstrapRecipe | null | undefined): asserts recipe is BootstrapRecipe {
  if (
    !recipe ||
    typeof recipe.bootstrapDir !== "string" ||
    !Array.isArray(recipe.files) ||
    !recipe.files.some((file) => file.path === `${recipe.bootstrapDir}/bridge.mjs`)
  ) {
    throw new Error("Verified runtime has no valid bootstrap recipe");
  }
}

/** The pack-recorded recipe, for a harness whose bridge ships in its pack. */
export async function withLocalPackBootstrap(adapter: HarnessAgentAdapter, root: string): Promise<HarnessAgentAdapter> {
  const recipe = JSON.parse(await readFile(join(root, "bootstrap.json"), "utf8")) as BootstrapRecipe;
  assertRecipe(recipe);
  return { ...adapter, getBootstrap: async () => recipe };
}

/** The recipe a local session runs, for whichever kind of runtime it resolved. */
export async function withLocalRuntimeBootstrap(
  adapter: HarnessAgentAdapter,
  runtime: Pick<ResolvedRuntime, "harnessId" | "rootPath" | "layer">,
): Promise<HarnessAgentAdapter> {
  if (runtime.layer === undefined) {
    return withLocalPackBootstrap(adapter, runtime.rootPath);
  }
  const recipe = inspectorLayerRecipe(runtime.harnessId) as BootstrapRecipe | null;
  if (recipe === null) {
    throw new Error(`${runtime.harnessId} has no Inspector-layer bootstrap recipe`);
  }
  assertRecipe(recipe);
  return { ...adapter, getBootstrap: async () => recipe };
}
