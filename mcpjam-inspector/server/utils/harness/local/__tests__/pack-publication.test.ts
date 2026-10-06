/**
 * Automated, resumable pack publication: the decisions every stage of
 * `local-harness-pack-pipeline.yml` re-derives from what already exists.
 *
 * The property under test is that a run can stop ANYWHERE and the next run
 * does the right thing: it never mints a second version for inputs that
 * already have one, never overwrites a release or a draft, finishes what an
 * earlier run left half done, and never publishes bytes users already have.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import {
  attestationVerifyArgs,
  classifyExisting,
  decideAfterBuild,
  decidePublication,
  EQUIVALENCE_SCHEMA,
  equivalenceFileName,
  failureIssueBody,
  failureIssueTitle,
  missingEvidence,
  nextPatchVersion,
  checkPinIntent,
  checkPinIntents,
  PIN_INTENT_SCHEMA,
  pinSummary,
  pipelineOutcome,
  readEquivalenceRecords,
  resumeCommand,
  versionFromTag,
} from "../../../../../scripts/local-harness-publication.mjs";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import { fingerprintAcceptance } from "../../../../../scripts/check-local-harness-release.mjs";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import { computeHarnessPackInputs } from "../../../../../scripts/check-local-harness-inputs.mjs";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import { evidenceFileName } from "../../../../../scripts/write-conformance-evidence.mjs";

const fp = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const digest = (n: number) => `sha256:${String(n).padStart(64, "0")}`;
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];
const digests = (n: number) => Object.fromEntries(TARGETS.map((t, i) => [t, digest(n * 10 + i)]));

const pinned = { version: "1.0.1", digests: digests(1), fingerprint: fp(1) };
const release = (version: string, fingerprint: string | null, extra: Partial<{ draft: boolean; complete: boolean }> = {}) => ({
  tag: `local-harness-pack-codex-v${version}`,
  version,
  draft: false,
  complete: true,
  fingerprint,
  ...extra,
});

describe("versions", () => {
  it("is always past every version that exists, released or drafted", () => {
    expect(nextPatchVersion([])).toBe("1.0.0");
    expect(nextPatchVersion(["1.0.0", "1.0.10", "1.0.9"])).toBe("1.0.11");
    expect(nextPatchVersion(["1.2.0", "1.10.0", "not-a-version"])).toBe("1.10.1");
  });

  it("reads a version only from this harness's own tags", () => {
    // Claude Code keeps the tag it first shipped under; every other harness
    // is namespaced. One harness's releases never count as another's.
    expect(versionFromTag("claude-code", "local-harness-pack-v1.0.3")).toBe("1.0.3");
    expect(versionFromTag("claude-code", "local-harness-pack-codex-v1.0.3")).toBeNull();
    expect(versionFromTag("codex", "local-harness-pack-codex-v1.0.3")).toBe("1.0.3");
    expect(versionFromTag("codex", "local-harness-pack-v1.0.3")).toBeNull();
    expect(versionFromTag("codex", "local-harness-pack-codex-v1.0")).toBeNull();
  });
});

describe("decidePublication: what a run does, from what exists", () => {
  it("does nothing when the pinned pack was built from these inputs", () => {
    expect(decidePublication({ fingerprint: fp(1), pinned, equivalences: [], releases: [] })).toMatchObject({
      action: "up-to-date",
      version: "1.0.1",
    });
  });

  it("does nothing when an equivalence record says a rebuild from these inputs reproduced the pin", () => {
    const record = { fingerprint: fp(2), packVersion: "1.0.1", digests: digests(1) };
    expect(decidePublication({ fingerprint: fp(2), pinned, equivalences: [record], releases: [] }).action).toBe("up-to-date");
    // …but only for exactly the pinned pack: a record about other bytes, or
    // another version, proves nothing about this pin.
    for (const stale of [
      { ...record, packVersion: "1.0.0" },
      { ...record, digests: { ...digests(1), "linux-x64": digest(999) } },
      { ...record, fingerprint: fp(3) },
    ]) {
      expect(decidePublication({ fingerprint: fp(2), pinned, equivalences: [stale], releases: [] }).action).toBe("build");
    }
  });

  it("adopts a release an earlier run already published from these inputs — and mints nothing", () => {
    const decision = decidePublication({
      fingerprint: fp(2),
      pinned,
      equivalences: [],
      releases: [release("1.0.1", fp(1)), release("1.0.2", fp(2))],
    });
    expect(decision).toMatchObject({ action: "adopt", version: "1.0.2" });
  });

  it("finishes a complete draft from these inputs instead of building again", () => {
    const decision = decidePublication({
      fingerprint: fp(2),
      pinned,
      equivalences: [],
      releases: [release("1.0.1", fp(1)), release("1.0.2", fp(2), { draft: true })],
    });
    expect(decision).toMatchObject({ action: "finish-draft", version: "1.0.2" });
  });

  it("never finishes an incomplete draft, and never reuses its version", () => {
    const decision = decidePublication({
      fingerprint: fp(2),
      pinned,
      equivalences: [],
      releases: [release("1.0.1", fp(1)), release("1.0.2", fp(2), { draft: true, complete: false })],
    });
    expect(decision).toMatchObject({ action: "build", version: "1.0.3" });
  });

  it("builds the next version past everything, including releases from other inputs", () => {
    const decision = decidePublication({
      fingerprint: fp(4),
      pinned,
      equivalences: [],
      // 1.0.2 was published and never pinned (its inputs were superseded);
      // 1.0.3 is someone's abandoned draft. Neither is touched or reused.
      releases: [release("1.0.1", fp(1)), release("1.0.2", fp(2)), release("1.0.3", fp(3), { draft: true })],
    });
    expect(decision).toMatchObject({ action: "build", version: "1.0.4" });
  });

  it("starts at 1.0.0 for a harness with nothing pinned or published", () => {
    expect(decidePublication({ fingerprint: fp(1), pinned: null, equivalences: [], releases: [] })).toMatchObject({
      action: "build",
      version: "1.0.0",
    });
  });
});

describe("decideAfterBuild: publish, or record an equivalence", () => {
  it("is equivalent only when every target reproduces the pinned tree", () => {
    expect(decideAfterBuild({ built: digests(1), pinned })).toEqual({ action: "equivalent", version: "1.0.1" });
    expect(decideAfterBuild({ built: { ...digests(1), "win32-x64": digest(7) }, pinned })).toEqual({ action: "publish" });
    // A build missing a target is not "the same pack".
    const { "win32-x64": _dropped, ...partial } = digests(1);
    expect(decideAfterBuild({ built: partial, pinned })).toEqual({ action: "publish" });
    expect(decideAfterBuild({ built: digests(1), pinned: null })).toEqual({ action: "publish" });
  });
});

describe("classifyExisting: the pack workflow's preflight at one version", () => {
  it("adopts its own earlier attempt and refuses anything else", () => {
    expect(classifyExisting({ fingerprint: fp(2), release: null })).toBe("none");
    expect(classifyExisting({ fingerprint: fp(2), release: { draft: false, fingerprint: fp(2), complete: true } })).toBe("published");
    expect(classifyExisting({ fingerprint: fp(2), release: { draft: true, fingerprint: fp(2), complete: true } })).toBe("draft");
    expect(classifyExisting({ fingerprint: fp(2), release: { draft: true, fingerprint: fp(2), complete: false } })).toBe("conflict");
    expect(classifyExisting({ fingerprint: fp(2), release: { draft: false, fingerprint: fp(1), complete: true } })).toBe("conflict");
    // A manifest not signed by our key carries no fingerprint as far as
    // adoption goes.
    expect(classifyExisting({ fingerprint: fp(2), release: { draft: false, fingerprint: null, complete: false } })).toBe("conflict");
  });
});

describe("equivalence records", () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

  it("are one file per (harness, fingerprint), read for their harness only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcpjam-equivalence-"));
    dirs.push(dir);
    const record = (harnessId: string, fingerprint: string) => ({
      schema: EQUIVALENCE_SCHEMA,
      harnessId,
      fingerprint,
      packVersion: "1.0.1",
      digests: digests(1),
    });
    await writeFile(join(dir, equivalenceFileName("codex", fp(2))), JSON.stringify(record("codex", fp(2))));
    await writeFile(join(dir, equivalenceFileName("claude-code", fp(3))), JSON.stringify(record("claude-code", fp(3))));
    // A file that names the harness but is not a record of that harness.
    await writeFile(join(dir, "codex-forged.json"), JSON.stringify({ ...record("claude-code", fp(4)) }));
    expect(equivalenceFileName("codex", fp(2))).toBe(`codex-${"2".repeat(16)}.json`);
    const read = readEquivalenceRecords("codex", dir);
    expect(read.map((r) => r.fingerprint)).toEqual([fp(2)]);
    expect(read[0]!.file).toBe(join(dir, equivalenceFileName("codex", fp(2))));
  });

  it("are not a pack input: recording one never moves the fingerprint it records", async () => {
    for (const harnessId of ["claude-code", "codex"]) {
      const { inputs } = await computeHarnessPackInputs(harnessId);
      expect(Object.keys(inputs).filter((path) => path.includes("local-harness-pack-equivalence"))).toEqual([]);
    }
  });
});

describe("the release gate's fingerprint rule", () => {
  const ref = { packVersion: "1.0.1", treeDigest: digests(1)["linux-x64"]! };
  const base = { harnessId: "codex", target: "linux-x64", ref, expectedFingerprint: fp(2) };

  it("accepts the desired pack built from this checkout's inputs", () => {
    expect(fingerprintAcceptance({ ...base, manifestFingerprint: fp(2), equivalences: [] })).toEqual({ kind: "built" });
  });

  it("accepts it through an equivalence record for exactly these inputs, version and tree", () => {
    const record = { harnessId: "codex", fingerprint: fp(2), packVersion: "1.0.1", digests: digests(1) };
    expect(fingerprintAcceptance({ ...base, manifestFingerprint: fp(1), equivalences: [record] })).toEqual({
      kind: "equivalent",
      record,
    });
    for (const wrong of [
      { ...record, harnessId: "claude-code" },
      { ...record, fingerprint: fp(3) },
      { ...record, packVersion: "1.0.0" },
      { ...record, digests: { ...digests(1), "linux-x64": digest(5) } },
    ]) {
      expect(fingerprintAcceptance({ ...base, manifestFingerprint: fp(1), equivalences: [wrong] })).toBeNull();
    }
  });

  it("accepts nothing when this checkout's fingerprint could not be computed", () => {
    expect(fingerprintAcceptance({ ...base, expectedFingerprint: null, manifestFingerprint: null, equivalences: [] })).toBeNull();
  });

  it("verifies provenance from the named workflow, on main, on a hosted runner", () => {
    expect(
      attestationVerifyArgs("/tmp/x.manifest.json", { repo: "MCPJam/inspector", workflow: ".github/workflows/local-harness-pack.yml" }),
    ).toEqual([
      "attestation",
      "verify",
      "/tmp/x.manifest.json",
      "--repo",
      "MCPJam/inspector",
      "--signer-workflow",
      "MCPJam/inspector/.github/workflows/local-harness-pack.yml",
      "--source-ref",
      "refs/heads/main",
      "--deny-self-hosted-runners",
    ]);
  });
});

describe("pin evidence", () => {
  const record = (target: string, treeDigest: string, extra: Record<string, unknown> = {}) => ({
    schema: "mcpjam.local-harness-conformance/1",
    result: "passed",
    harnessId: "codex",
    target,
    pack: { treeDigest },
    commit: "abc",
    ...extra,
  });

  it("requires a passed record for this exact tree, from this commit, on every advertised target", () => {
    const d = digests(2);
    const input = { harnessId: "codex", targets: ["linux-x64", "darwin-arm64"], digests: d, commit: "abc" };
    expect(missingEvidence({ ...input, records: [record("linux-x64", d["linux-x64"]!), record("darwin-arm64", d["darwin-arm64"]!)] })).toEqual([]);
    expect(missingEvidence({ ...input, records: [record("linux-x64", d["linux-x64"]!)] })).toEqual(["darwin-arm64"]);
    // Another tree, another commit, a failed leg, another harness: none count.
    for (const wrong of [
      record("darwin-arm64", digest(1)),
      record("darwin-arm64", d["darwin-arm64"]!, { commit: "old" }),
      record("darwin-arm64", d["darwin-arm64"]!, { result: "failed" }),
      record("darwin-arm64", d["darwin-arm64"]!, { harnessId: "claude-code" }),
    ]) {
      expect(missingEvidence({ ...input, records: [record("linux-x64", d["linux-x64"]!), wrong] })).toEqual(["darwin-arm64"]);
    }
  });

  it("names each record by the FULL digest, so a candidate and its predecessor never collide", () => {
    // The pipeline downloads the candidate's and the previous pack's evidence
    // into one directory. Two trees sharing a 12-character prefix must not
    // overwrite each other's record there.
    const prefix = "0123456789ab";
    const one = `sha256:${prefix}${"c".repeat(52)}`;
    const two = `sha256:${prefix}${"d".repeat(52)}`;
    const names = [one, two].map((treeDigest) => evidenceFileName({ harnessId: "codex", target: "linux-x64", treeDigest }));
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe(`conformance-evidence-codex-linux-x64-${one.slice(7)}.json`);
  });
});

describe("the pipeline's paper trail", () => {
  it("names the first stage that failed, and ignores the previous pack's conformance", () => {
    expect(pipelineOutcome({ plan: { result: "success" }, pack: { result: "failure" }, pin: { result: "skipped" } })).toMatchObject({
      status: "failed",
      stage: "build-and-publish",
    });
    expect(
      pipelineOutcome({
        plan: { result: "success" },
        pack: { result: "success" },
        "candidate-conformance": { result: "failure" },
        pin: { result: "skipped" },
      }),
    ).toMatchObject({ status: "failed", stage: "conformance", meaning: expect.stringMatching(/NOT pinned/) });
    // The previous pack failing only means it is not kept selectable.
    expect(
      pipelineOutcome({
        plan: { result: "success" },
        pack: { result: "skipped" },
        "candidate-conformance": { result: "success" },
        "previous-conformance": { result: "failure" },
        pin: { result: "success" },
      }),
    ).toEqual({ status: "succeeded" });
  });

  it("treats a run superseded by a newer one as neither failure nor success", () => {
    expect(pipelineOutcome({ plan: { result: "success" }, pack: { result: "cancelled" } })).toEqual({ status: "cancelled" });
  });

  it("an up-to-date run is a success (and closes an open failure issue)", () => {
    expect(
      pipelineOutcome({ plan: { result: "success" }, pack: { result: "skipped" }, pin: { result: "skipped" } }),
    ).toEqual({ status: "succeeded" });
  });

  it("tells whoever reads the issue what failed, what it means, and the one command that resumes it", () => {
    const body = failureIssueBody({
      harnessId: "codex",
      stage: "pin",
      meaning: "handing the pin to the release failed",
      runUrl: "https://github.com/MCPJam/inspector/actions/runs/1",
      commit: "0123456789abcdef",
    });
    expect(body).toContain("**pin**");
    expect(body).toContain("0123456789ab");
    expect(body).toContain("https://github.com/MCPJam/inspector/actions/runs/1");
    expect(body).toContain(resumeCommand("codex"));
    expect(resumeCommand("codex")).toBe("gh workflow run prepare-release.yml --ref main");
    expect(failureIssueTitle("codex")).not.toBe(failureIssueTitle("claude-code"));
  });

  it("hands the release one intent per harness, and says whether the previous pack stays selectable", () => {
    const pin = {
      schema: PIN_INTENT_SCHEMA,
      harness: "codex",
      kind: "pin" as const,
      version: "1.0.2",
      digests: digests(2),
      fingerprint: fp(2),
      conformance: "published-codex-1.0.2-abcdef012345",
      previous: "1.0.1",
      permitPrevious: true,
      run: "https://github.com/MCPJam/inspector/actions/runs/1",
    };
    const upToDate = { schema: PIN_INTENT_SCHEMA, harness: "claude-code", kind: "up-to-date" as const, version: "1.0.1" };
    const intents = checkPinIntents([pin, upToDate], ["claude-code", "codex"]);
    // In recipe order, whatever order the artifacts arrived in.
    expect(intents.map((intent) => intent.harness)).toEqual(["claude-code", "codex"]);
    const summary = pinSummary(intents);
    expect(summary).toMatch(/\*\*codex\*\*: pins new pack \*\*1\.0\.2\*\*/);
    expect(summary).toMatch(/1\.0\.1 stays selectable as the permitted previous pack/);
    expect(summary).toMatch(/\*\*claude-code\*\*: unchanged \(1\.0\.1\)/);
    const refused = pinSummary([{ ...pin, permitPrevious: false, permitReason: "it has no build provenance" }]);
    expect(refused).toMatch(/NOT kept as a permitted previous pack: it has no build provenance/);
    const equivalence = {
      schema: PIN_INTENT_SCHEMA,
      harness: "codex",
      kind: "equivalence" as const,
      previous: "1.0.1",
      record: "mcpjam-inspector/scripts/local-harness-pack-equivalence/codex-abc.json",
      sha256: "a".repeat(64),
    };
    expect(pinSummary([checkPinIntent(equivalence)])).toMatch(/users download nothing/);
  });

  it("refuses a release that cannot say what every harness pins", () => {
    const upToDate = (harness: string) => ({ schema: PIN_INTENT_SCHEMA, harness, kind: "up-to-date" });
    // A harness whose pipeline did not finish handed nothing over.
    expect(() => checkPinIntents([upToDate("codex")], ["claude-code", "codex"])).toThrow(/no pin intent for claude-code/);
    expect(() => checkPinIntents([upToDate("codex"), upToDate("codex")], ["codex"])).toThrow(/two pin intents/);
    expect(() => checkPinIntents([upToDate("codex"), upToDate("other")], ["codex"])).toThrow(/unknown harnesses: other/);
    expect(() => checkPinIntent({ schema: PIN_INTENT_SCHEMA, harness: "codex", kind: "pin", version: "1.0.2", digests: {}, conformance: "x" })).toThrow(/needs digests/);
    expect(() =>
      checkPinIntent({ schema: PIN_INTENT_SCHEMA, harness: "codex", kind: "pin", version: "1.0.2", digests: digests(2), conformance: "x", run: "https://example/run" }),
    ).toThrow(/run URL/);
    expect(() =>
      checkPinIntent({ schema: PIN_INTENT_SCHEMA, harness: "codex", kind: "pin", version: "1.0.2", digests: { "linux-x64": "sha256:nope" }, conformance: "x" }),
    ).toThrow(/not sha256/);
    // An equivalence record lands only in the records directory, by name.
    for (const record of [
      "mcpjam-inspector/scripts/local-harness-pack-equivalence/../../package.json",
      "mcpjam-inspector/server/evil.json",
      "mcpjam-inspector/scripts/local-harness-pack-equivalence/nested/x.json",
    ]) {
      expect(() => checkPinIntent({ schema: PIN_INTENT_SCHEMA, harness: "codex", kind: "equivalence", record, sha256: "a".repeat(64) })).toThrow(/is not a file in/);
    }
  });
});

describe("a re-run after a failure at each stage adopts the same version", () => {
  // What exists after the pipeline stopped at each stage, for inputs fp(2)
  // whose next version is 1.0.2, and what the re-run then does. Every row
  // lands on 1.0.2: nothing is rebuilt that exists, nothing is minted twice.
  const fingerprint = fp(2);
  const rows: Array<[string, Array<ReturnType<typeof release>>, string]> = [
    ["the build (nothing uploaded)", [release("1.0.1", fp(1))], "build"],
    ["signing or upload (no release yet)", [release("1.0.1", fp(1))], "build"],
    ["between upload and publish (a complete draft)", [release("1.0.1", fp(1)), release("1.0.2", fingerprint, { draft: true })], "finish-draft"],
    ["conformance (published, not pinned)", [release("1.0.1", fp(1)), release("1.0.2", fingerprint)], "adopt"],
    ["the pin (published, not pinned)", [release("1.0.1", fp(1)), release("1.0.2", fingerprint)], "adopt"],
  ];
  it.each(rows)("stopped at %s", (_stage, releases, action) => {
    expect(decidePublication({ fingerprint, pinned, equivalences: [], releases })).toMatchObject({ action, version: "1.0.2" });
  });

  it("once the version PR pinning it merges, the re-run has nothing to do", () => {
    const merged = { version: "1.0.2", digests: digests(2), fingerprint };
    expect(decidePublication({ fingerprint, pinned: merged, equivalences: [], releases: [release("1.0.2", fingerprint)] }).action).toBe("up-to-date");
  });
});

describe("a workflow-only change publishes nothing, and the release passes on the equivalence", () => {
  it("is equivalent after the build, then up-to-date, then accepted by the gate on every target", () => {
    const changedInputs = fp(7);
    expect(decideAfterBuild({ built: digests(1), pinned })).toEqual({ action: "equivalent", version: "1.0.1" });
    const record = { harnessId: "codex", fingerprint: changedInputs, packVersion: "1.0.1", digests: digests(1) };
    expect(decidePublication({ fingerprint: changedInputs, pinned, equivalences: [record], releases: [release("1.0.1", fp(1))] }).action).toBe(
      "up-to-date",
    );
    for (const [target, treeDigest] of Object.entries(digests(1))) {
      expect(
        fingerprintAcceptance({
          harnessId: "codex",
          target,
          ref: { packVersion: "1.0.1", treeDigest },
          manifestFingerprint: fp(1),
          expectedFingerprint: changedInputs,
          equivalences: [record],
        }),
      ).toMatchObject({ kind: "equivalent" });
    }
  });
});

