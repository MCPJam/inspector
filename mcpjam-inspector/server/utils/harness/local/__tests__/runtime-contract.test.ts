/**
 * The runtime contract: which packs a build may select (the generated
 * compatibility record), which conformance legs prove it (the plan), and the
 * release gate that refuses to ship a layer that was not run against every
 * pack it may select.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import { parseRuntimeCompat } from "../../../../../scripts/local-harness-pack-tables.mjs";
// eslint-disable-next-line import/extensions -- plain ESM script
import { planConformance } from "../../../../../scripts/plan-local-harness-conformance.mjs";
import { inspectorLayerDigest } from "../inspector-layer.js";
import {
  EXPECTED_PACK_VERSIONS,
  PACK_RECORDS,
  PERMITTED_PACK_RECORDS,
} from "../pack-digests.generated.js";
import {
  compatiblePacksFor,
  parseRuntimeCompatRecord,
  RUNTIME_COMPAT,
} from "../runtime-compat.js";

const execFileP = promisify(execFile);
const COMMITTED = readFileSync(new URL("../runtime-compat.generated.json", import.meta.url), "utf8");
const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;

describe("the generated compatibility record", () => {
  it("is read the same way by the server and by the scripts", () => {
    const scripts = parseRuntimeCompat(COMMITTED);
    expect(JSON.parse(JSON.stringify(RUNTIME_COMPAT))).toEqual(scripts);
  });

  it("derives the legacy tables from the desired pack, and the permitted one beside them", () => {
    for (const [harnessId, entry] of Object.entries(RUNTIME_COMPAT.harnesses)) {
      for (const [target, slot] of Object.entries(entry.targets)) {
        expect(PACK_RECORDS[harnessId as "codex"][target as "linux-x64"]).toEqual(slot!.desired);
        expect(PERMITTED_PACK_RECORDS[harnessId as "codex"][target as "linux-x64"]).toEqual(slot!.permitted);
        expect(EXPECTED_PACK_VERSIONS[harnessId as "codex"]).toBe(slot!.desired.packVersion);
      }
    }
  });

  it("offers the desired pack first and at most one permitted previous", () => {
    const packs = compatiblePacksFor("codex", "linux-x64");
    expect(packs[0]).toMatchObject({ role: "desired" });
    expect(packs.length).toBeLessThanOrEqual(2);
  });

  it.each([
    ["an unknown schema", { schema: 2, harnesses: {} }, /unknown schema/],
    [
      "a missing conformance stamp",
      { schema: 1, harnesses: { codex: { targets: {} } } },
      /no conformance version/,
    ],
    [
      "an unknown target",
      { schema: 1, harnesses: { codex: { conformance: { version: "" }, targets: { "sunos-sparc": { desired: { packVersion: "1.0.0", treeDigest: A } } } } } },
      /unknown target/,
    ],
    [
      "a desired pack permitted as its own previous",
      { schema: 1, harnesses: { codex: { conformance: { version: "" }, targets: { "linux-x64": { desired: { packVersion: "1.0.0", treeDigest: A }, permitted: { packVersion: "1.0.0", treeDigest: B } } } } } },
      /permits the desired pack/,
    ],
    [
      "two desired versions across targets",
      { schema: 1, harnesses: { codex: { conformance: { version: "" }, targets: {
        "linux-x64": { desired: { packVersion: "1.0.0", treeDigest: A } },
        "darwin-arm64": { desired: { packVersion: "1.0.1", treeDigest: B } },
      } } } },
      /more than one pack version/,
    ],
    [
      "a digest that is not a tree digest",
      { schema: 1, harnesses: { codex: { conformance: { version: "" }, targets: { "linux-x64": { desired: { packVersion: "1.0.0", treeDigest: "md5:x" } } } } } },
      /not a pack reference/,
    ],
  ])("refuses %s at load", (_label, record, error) => {
    expect(() => parseRuntimeCompatRecord(record)).toThrow(error);
  });
});

describe("which conformance legs run", () => {
  const record = parseRuntimeCompat(COMMITTED);
  const desired = (id: string) =>
    Object.values(record.harnesses[id]!.targets)[0]!.desired.packVersion;

  it("runs a pull request's layer against the PINNED published packs, on Linux x64 only", () => {
    const plan = planConformance({ event: "pull_request", record });
    expect(plan.claude_pack_version).toBe(desired("claude-code"));
    expect(plan.codex_pack_version).toBe(desired("codex"));
    expect(JSON.parse(plan.posix_matrix).map((leg: { platform_key: string }) => leg.platform_key)).toEqual(["linux-x64"]);
    expect(JSON.parse(plan.codex_matrix).map((leg: { platform_key: string }) => leg.platform_key)).toEqual(["linux-x64"]);
    expect(plan.run_windows).toBe("false");
  });

  it("builds from source on every platform for a main push", () => {
    const plan = planConformance({ event: "push", record });
    expect(plan.claude_pack_version).toBe("");
    expect(plan.codex_pack_version).toBe("");
    expect(JSON.parse(plan.posix_matrix)).toHaveLength(4);
    expect(JSON.parse(plan.codex_matrix)).toHaveLength(4);
    expect(plan.run_windows).toBe("true");
  });

  it("runs only the harnesses a release's second (permitted) call names", () => {
    const plan = planConformance({ event: "workflow_call", codexVersion: "1.0.0", harnesses: "codex", record });
    expect(plan).toMatchObject({ run_claude: "false", run_codex: "true", run_windows: "false", codex_pack_version: "1.0.0" });
  });

  it("refuses a version that is not a pack semver", () => {
    expect(() => planConformance({ event: "workflow_call", codexVersion: "1.0.0; rm -rf", record })).toThrow(/not a pack version/);
  });
});

describe("the release gate's conformance evidence", () => {
  const script = fileURLToPath(new URL("../../../../../scripts/check-local-harness-release.mjs", import.meta.url));
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcpjam-evidence-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** One evidence record per advertised target, optionally skipping one. */
  async function writeEvidence(opts: { skip?: string; layer?: string | null } = {}) {
    await rm(dir, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const advertised: Record<string, string[]> = {
      "claude-code": ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"],
      codex: ["darwin-arm64", "linux-x64"],
    };
    for (const [harnessId, targets] of Object.entries(advertised)) {
      for (const target of targets) {
        if (opts.skip === `${harnessId}/${target}`) continue;
        const slot = RUNTIME_COMPAT.harnesses[harnessId as "codex"].targets[target as "linux-x64"]!;
        for (const ref of [slot.desired, ...(slot.permitted ? [slot.permitted] : [])]) {
          await writeFile(
            join(dir, `conformance-evidence-${harnessId}-${target}-${ref.treeDigest.slice(7, 15)}.json`),
            JSON.stringify({
              schema: "mcpjam.local-harness-conformance/1",
              result: "passed",
              harnessId,
              target,
              pack: { treeDigest: ref.treeDigest, packVersion: ref.packVersion },
              layerDigest: opts.layer !== undefined && harnessId === "codex" ? opts.layer : inspectorLayerDigest(harnessId as "codex"),
              commit: "c0ffee",
              run: `https://github.com/MCPJam/inspector/actions/runs/${harnessId.length}`,
            }),
          );
        }
      }
    }
  }

  async function gate(extra: string[] = []) {
    try {
      const { stdout } = await execFileP(process.execPath, [script, "--version", "9.9.9", "--evidence", dir, "--commit", "c0ffee", ...extra], {
        cwd: fileURLToPath(new URL("../../../../../", import.meta.url)),
      });
      return { code: 0, out: stdout };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, out: `${failed.stdout}${failed.stderr}` };
    }
  }

  it("passes when this commit's layer ran against every selected pack, and writes the contract", async () => {
    await writeEvidence();
    const contractPath = join(dir, "..", `runtime-contract-${process.pid}.json`);
    const result = await gate(["--contract", contractPath]);
    expect(result.out).toMatch(/target\(s\) ready/);
    expect(result.code).toBe(0);
    const contract = JSON.parse(await readFile(contractPath, "utf8"));
    expect(contract).toMatchObject({
      schema: "mcpjam.local-harness-runtime-contract/1",
      inspectorVersion: "9.9.9",
      commit: "c0ffee",
    });
    expect(contract.harnesses.codex.layerDigest).toBe(inspectorLayerDigest("codex"));
    expect(contract.harnesses.codex.targets["linux-x64"].desired).toEqual({
      ...RUNTIME_COMPAT.harnesses.codex.targets["linux-x64"]!.desired,
      evidence: "https://github.com/MCPJam/inspector/actions/runs/5",
    });
    await rm(contractPath, { force: true });
  }, 120_000);

  it("blocks a release with a target nobody ran", async () => {
    await writeEvidence({ skip: "codex/darwin-arm64" });
    const result = await gate();
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/no conformance evidence for codex darwin-arm64/);
  }, 120_000);

  it("blocks evidence gathered with a different layer than this commit compiles", async () => {
    await writeEvidence({ layer: `sha256:${"9".repeat(64)}` });
    const result = await gate();
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/no conformance evidence for codex linux-x64: this commit's Inspector layer/);
  }, 120_000);

  it("blocks evidence from a different commit", async () => {
    await writeEvidence();
    const result = await gate(["--commit", "deadbeef"]);
    expect(result.code).not.toBe(0);
  }, 120_000);
});
