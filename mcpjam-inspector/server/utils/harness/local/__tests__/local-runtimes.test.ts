import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import { LOCAL_HARNESS_IDS, harnessSurfaceRefusal } from "@/shared/harness-descriptors";
import { listPackHarnessIds } from "../../../../../scripts/local-harness-pack-harnesses.mjs";
import { readManifestFacts } from "../../../../../scripts/local-harness-pack-tables.mjs";
import {
  LOCAL_HARNESS_LAYER_FILES,
  LOCAL_HARNESS_LAYER_RECIPES,
} from "../layer/generated/local-harness-layer.bundled.js";
import { LOCAL_RUNTIMES, localRuntimeOf } from "../runtimes/index.js";
import type { SupportedLocalHarnessId } from "../targets.js";

/**
 * A runtime runs on the member's computer exactly when it declares no `local`
 * exception, and then everything the local runner needs about it is in ONE
 * definition (`runtimes/<harnessId>.ts`). These pin the pieces that live
 * outside TypeScript's reach (the pack recipes, the layer bundler, the release
 * scripts' text parser) to that definition, and keep harness ids out of the
 * generic runner.
 */
const here = dirname(fileURLToPath(import.meta.url));
const localDir = join(here, "..");
const serverDir = join(localDir, "../../..");
const ids = (Object.keys(LOCAL_RUNTIMES) as SupportedLocalHarnessId[]).sort();

describe("local runtime definitions", () => {
  it("cover exactly the runtimes that declare no local exception", () => {
    expect(ids).toEqual([...LOCAL_HARNESS_IDS].sort());
    for (const id of HARNESS_IDS) {
      expect(localRuntimeOf(id) !== undefined).toBe(!harnessSurfaceRefusal(id, "local"));
    }
  });

  it.each(ids)("%s names itself, in its manifest too", (id) => {
    expect(LOCAL_RUNTIMES[id].harnessId).toBe(id);
    expect(LOCAL_RUNTIMES[id].manifest.harnessId).toBe(id);
  });

  it("each has a pack recipe, and every pack recipe a definition", () => {
    expect(listPackHarnessIds()).toEqual(ids);
  });

  it.each(ids)("%s's layer files are the ones the layer bundler builds", (id) => {
    expect(Object.keys(LOCAL_HARNESS_LAYER_FILES[id] ?? {}).sort()).toEqual(
      [...LOCAL_RUNTIMES[id].layerFiles].sort(),
    );
    expect(LOCAL_HARNESS_LAYER_RECIPES[id]?.harnessId).toBe(id);
  });

  it("the layer bundler builds no layer for a runtime that is not local", () => {
    expect(Object.keys(LOCAL_HARNESS_LAYER_FILES).sort()).toEqual(ids);
  });

  it.each(ids)("%s's platforms read the same in the release scripts", (id) => {
    const { manifest } = LOCAL_RUNTIMES[id];
    const facts = readManifestFacts()[id];
    expect(facts?.nativePlatforms).toEqual([...manifest.nativePlatforms]);
    expect(facts?.nativeTargets).toEqual(
      manifest.nativeTargets === undefined ? undefined : [...manifest.nativeTargets],
    );
  });

  it.each(ids)("%s's version probe and bridge flags are among its reviewed shapes", (id) => {
    const { commands } = LOCAL_RUNTIMES[id];
    expect(commands.shapes).toContain(commands.versionProbe);
    const launch = commands.shapes.find((shape) => shape.startsWith("node '<bootstrapDir>/bridge.mjs'"));
    expect(launch?.match(/--[a-z-]+/g)).toEqual([...commands.bridgeFlags]);
    for (const flag of commands.sessionStateFlags) expect(commands.bridgeFlags).toContain(flag);
  });
});

describe("the generic local runner", () => {
  /**
   * Literals that are not per-runtime facts, each with its reason. Anything
   * else a runtime needs belongs in its definition.
   */
  const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    // Stored records that Inspectors already shipped also read and validate.
    "authorization.ts": ["claude-code", "codex"],
    "grants.ts": ["claude-code", "codex"],
    // Claude Code's release names and install root predate per-runtime names.
    "pack-naming.ts": ["claude-code"],
    "runtime-lifecycle.ts": ["claude-code"],
    // The adapters' own resume-state shapes, which hosted turns share.
    "resume-state.ts": ["claude-code", "codex", "cursor"],
  };

  it("names no runtime outside its definition", () => {
    const files = [
      ...readdirSync(localDir)
        .filter((name) => name.endsWith(".ts") && !name.includes(".generated."))
        .map((name) => join(localDir, name)),
      join(serverDir, "routes/mcp/local-harness.ts"),
      join(serverDir, "harness-install-cli.ts"),
    ];
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const id of HARNESS_IDS) {
        if (!new RegExp(`["'\`]${id}["'\`]`).test(text)) continue;
        if ((ALLOWED[basename(file)] ?? []).includes(id)) continue;
        found.push(`${relative(serverDir, file)}: "${id}"`);
      }
    }
    expect(
      found,
      "Per-runtime facts belong in server/utils/harness/local/runtimes/<harnessId>.ts; " +
        "read them through the LocalRuntime definition instead of naming the runtime here.",
    ).toEqual([]);
  });
});
