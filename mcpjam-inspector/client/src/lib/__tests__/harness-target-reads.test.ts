import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import {
  harnessTargetOfClient,
  harnessTargetOfHost,
} from "@/lib/harness-model-locks";

/**
 * Ratchet: read a client's runtime with `effectiveHarnessId` or
 * `harnessTargetOfClient`, not off `.harness` alone.
 *
 * A client paired with a vendor runtime (Claude → Claude Code, ChatGPT →
 * Codex, Cursor, VS Code → Copilot CLI) stores it in `agentLoop` and leaves
 * `harness` empty. A picker that reads `harness` alone treats it as an
 * emulated client and locks nothing, while the Playground (which reads both)
 * grays out the same models. That is how the eval and swarm pickers drifted
 * from the Playground.
 *
 * This test fails when a file gains a `.harness` read on a client config or
 * host that does not also mention `agentLoop`. Copying the field through
 * (`harness: config.harness,`) is fine. The files below already did this
 * when the test was added; each is either intentional (the code means "a
 * harness client, not a paired one") or still to audit. Fix one and lower
 * its count; never raise one.
 */
const KNOWN_HARNESS_ONLY_READS: Record<string, number> = {
  // Narrows a caller-supplied `HarnessModelTarget` object, not a config.
  "components/evaluate/eval-target-matrix.tsx": 1,
  "components/HostsTab.tsx": 1,
  "components/hosts/redesigned/focus/BehaviorTab.tsx": 1,
  "components/hosts/redesigned/focus/ToolsTab.tsx": 2,
  "components/hosts/redesigned/client-save-telemetry.ts": 1,
  "components/evals/test-template-editor.tsx": 2,
  "components/playground/PlaygroundRightRail.tsx": 2,
  "components/ui-playground/PlaygroundMain.tsx": 1,
  "lib/playground/apply-client-defaults.ts": 1,
};

const CLIENT_SRC = resolve(fileURLToPath(import.meta.url), "../../..");

const HARNESS_READ =
  /\b(?:config|hostConfig|hostConfigBaseline|cfg|draft|host)\??\.harness\b/;
const PASSTHROUGH = /^\s*harness: [\w?.]+\.harness(?: \?\? \w+)?,?\s*$/;
const COMMENT = /^\s*(?:\*|\/\/)/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__")
        continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function harnessOnlyReads(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of sourceFiles(CLIENT_SRC)) {
    const file = relative(CLIENT_SRC, path).split(sep).join("/");
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!HARNESS_READ.test(line)) continue;
      if (line.includes("agentLoop")) continue;
      if (PASSTHROUGH.test(line) || COMMENT.test(line)) continue;
      counts[file] = (counts[file] ?? 0) + 1;
    }
  }
  return counts;
}

describe("client runtime reads", () => {
  it("reads a paired client's runtime from agentLoop", () => {
    expect(harnessTargetOfClient({ agentLoop: "claude-code", harness: null }))
      .toEqual({ harnessId: "claude-code" });
    expect(harnessTargetOfClient({ harness: "codex" })).toEqual({
      harnessId: "codex",
    });
    expect(harnessTargetOfClient({})).toBeNull();
  });

  it("prefers the backend's resolved runtime, and falls back without it", () => {
    expect(harnessTargetOfHost({ runtime: "codex", harness: null })).toEqual({
      harnessId: "codex",
    });
    // MCPJam Harness: the backend says null even if a stale field is set.
    expect(harnessTargetOfHost({ runtime: null, agentLoop: "codex" })).toBeNull();
    // An older backend: no `runtime`, read the config's own fields.
    expect(
      harnessTargetOfHost({ config: { agentLoop: "claude-code", harness: null } }),
    ).toEqual({ harnessId: "claude-code" });
    expect(harnessTargetOfHost({ agentLoop: "cursor" })).toEqual({
      harnessId: "cursor",
    });
  });

  it("adds no `.harness`-only reads", () => {
    const found = harnessOnlyReads();
    const grown = Object.entries(found)
      .filter(([file, count]) => count > (KNOWN_HARNESS_ONLY_READS[file] ?? 0))
      .map(([file, count]) => `${file}: ${count}`);
    expect(
      grown,
      "Read the runtime with effectiveHarnessId / harnessTargetOfClient " +
        "so paired clients (Claude, ChatGPT) are not treated as emulated.",
    ).toEqual([]);
  });

  it("keeps the known list tight", () => {
    const found = harnessOnlyReads();
    const stale = Object.entries(KNOWN_HARNESS_ONLY_READS)
      .filter(([file, count]) => (found[file] ?? 0) < count)
      .map(([file]) => `${file}: now ${found[file] ?? 0}`);
    expect(stale, "Lower these counts in KNOWN_HARNESS_ONLY_READS.").toEqual(
      [],
    );
  });
});
