/**
 * The Inspector layer's CONTENTS, as compiled into this build — pure data and
 * a digest, no disk access. Split from `inspector-layer.ts` so the release
 * tooling (`scripts/inspector-layer-digests.mjs`) can compute the exact digest
 * a build will verify against without loading the server.
 */
import {
  LOCAL_HARNESS_LAUNCHER_SOURCE,
  LOCAL_HARNESS_LAYER_FILES,
  LOCAL_HARNESS_LAYER_RECIPES,
} from "./layer/generated/local-harness-layer.bundled.js";
import { localRuntimeOf } from "./runtimes/index.js";
import type { SupportedLocalHarnessId } from "./targets.js";
import { digestFileSet } from "./tree-digest.js";

export const INSPECTOR_LAYER_SCHEMA = "mcpjam.inspector-layer/1";
/** The directory every layer lives under, inside the runtime root. */
export const INSPECTOR_LAYER_DIRNAME = "inspector-layer";

export interface InspectorLayerFile {
  /** Relative to the layer root; a flat name. */
  path: string;
  content: string;
}

/**
 * The files of one runtime's layer, from the bytes compiled into this build:
 * the files its definition names (`layerFiles`), then the launcher and
 * `layer.json`. `null` for an id that names no local runtime.
 *
 * `layer.json` names the harness so that two harnesses can never share a
 * layer directory, even if their bridges were ever byte-identical.
 */
export function inspectorLayerFiles(
  harnessId: SupportedLocalHarnessId,
): readonly InspectorLayerFile[] | null {
  const runtime = localRuntimeOf(harnessId);
  if (runtime === undefined) return null;
  const built = Object.prototype.hasOwnProperty.call(LOCAL_HARNESS_LAYER_FILES, harnessId)
    ? LOCAL_HARNESS_LAYER_FILES[harnessId]
    : undefined;
  const files = runtime.layerFiles.map((path) => {
    const content = built?.[path];
    if (typeof content !== "string") {
      throw new Error(
        `the Inspector layer for ${harnessId} has no ${path}: rebuild it with ` +
          `scripts/bundle-local-harness-layer.mjs, which must build every file ` +
          `the runtime's definition names`,
      );
    }
    return { path, content };
  });
  return [
    ...files,
    { path: "launcher.mjs", content: LOCAL_HARNESS_LAUNCHER_SOURCE },
    {
      path: "layer.json",
      content: `${JSON.stringify({ schema: INSPECTOR_LAYER_SCHEMA, harnessId })}\n`,
    },
  ];
}

/**
 * The bootstrap recipe a LOCAL session hands the framework: the adapter's
 * declared directory and commands (captured when the layer was bundled) and
 * the layer's own bridge files. Built entirely from constants compiled into
 * this build — never by asking the adapter package, which a packaged Electron
 * app has no unpacked copy of.
 */
export function inspectorLayerRecipe(harnessId: SupportedLocalHarnessId): {
  harnessId: string;
  bootstrapDir: string;
  files: Array<{ path: string; content: string }>;
  commands: Array<{ command: string }>;
} | null {
  const files = inspectorLayerRecipeFiles(harnessId);
  const meta = Object.prototype.hasOwnProperty.call(LOCAL_HARNESS_LAYER_RECIPES, harnessId)
    ? LOCAL_HARNESS_LAYER_RECIPES[harnessId]
    : undefined;
  if (files === null || meta === undefined) return null;
  return {
    harnessId: meta.harnessId,
    bootstrapDir: meta.bootstrapDir,
    files: files.map((file) => ({
      path: `${meta.bootstrapDir}/${file.path}`,
      content: file.content,
    })),
    commands: meta.commands.map((command) => ({ ...command })),
  };
}

/** The files of a layer the ADAPTER's bootstrap recipe names — the ones a
 *  session's `writeTextFile` is compared against. Not the launcher or
 *  `layer.json`, which are the Inspector's and no adapter writes. */
export function inspectorLayerRecipeFiles(
  harnessId: SupportedLocalHarnessId,
): readonly InspectorLayerFile[] | null {
  const files = inspectorLayerFiles(harnessId);
  return files === null
    ? null
    : files.filter((file) => file.path !== "launcher.mjs" && file.path !== "layer.json");
}

const digestCache = new Map<SupportedLocalHarnessId, string | null>();

/**
 * The tree digest of one harness's layer as compiled into THIS build, or
 * `null` when the harness has no layer. Folded into the launch identity.
 */
export function inspectorLayerDigest(
  harnessId: SupportedLocalHarnessId,
): string | null {
  if (!digestCache.has(harnessId)) {
    const files = inspectorLayerFiles(harnessId);
    digestCache.set(
      harnessId,
      files === null
        ? null
        : digestFileSet(files.map((file) => ({ path: file.path, content: file.content }))),
    );
  }
  return digestCache.get(harnessId)!;
}

