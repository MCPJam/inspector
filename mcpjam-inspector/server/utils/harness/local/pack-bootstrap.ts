/**
 * The bootstrap recipe a LOCAL session hands the framework.
 *
 * Never the adapter's own recipe as-is: that one installs a vendor graph into
 * a sandbox, and locally the verified runtime already is that graph.
 *
 *  - A harness with an Inspector layer (Codex): the recipe's files are the
 *    layer's (`inspectorLayerRecipeFiles`), from the bytes compiled into this
 *    build, so the framework's writes compare equal to the layer copy by
 *    construction. Its commands are the adapter's, which the translator turns
 *    into no-ops. Nothing is read from the pack, so a bridge change needs no
 *    new pack.
 *  - A harness whose bridge still ships in its pack (`launcherSource: "pack"`):
 *    the recipe the pack build recorded in `bootstrap.json`, read from the
 *    reserved, digest-verified pack — including in Electron, which has no
 *    unpacked adapter `node_modules` to ask.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { inspectorLayerRecipeFiles } from "./inspector-layer.js";
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
  const files = inspectorLayerRecipeFiles(runtime.harnessId);
  const original = adapter.getBootstrap?.bind(adapter);
  if (files === null || original === undefined) {
    throw new Error(`${runtime.harnessId} has no Inspector-layer bootstrap recipe`);
  }
  let cached: BootstrapRecipe | undefined;
  return {
    ...adapter,
    getBootstrap: async (...args) => {
      if (cached) return cached;
      const upstream = await original(...args);
      const recipe: BootstrapRecipe = {
        ...upstream,
        files: files.map((file) => ({
          path: `${upstream.bootstrapDir}/${file.path}`,
          content: file.content,
        })),
      };
      assertRecipe(recipe);
      cached = recipe;
      return recipe;
    },
  };
}
