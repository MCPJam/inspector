import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const workflowsDir = new URL("../../../../../../.github/workflows/", import.meta.url);
const workflow = (name: string) => parse(readFileSync(new URL(`${name}.yml`, workflowsDir), "utf8"));

describe("packs are part of starting a release", () => {
  it("brings every harness's pack up to date before the version PR opens", () => {
    const { jobs } = workflow("prepare-release");
    expect(jobs.packs.uses).toBe("./.github/workflows/local-harness-pack-pipeline.yml");
    expect(jobs.packs.strategy.matrix.harness).toBe("${{ fromJSON(needs.harnesses.outputs.list) }}");
    expect(jobs.packs.strategy["fail-fast"]).toBe(false);
    expect(jobs.packs.with.harness).toBe("${{ matrix.harness }}");
    // A failed pipeline means no version PR: the release cannot say what it pins.
    expect(jobs["version-pr"].needs).toBe("packs");
    expect(jobs["version-pr"].if).toBeUndefined();

    // Pins are written onto the version branch, then the gate checks exactly
    // what the PR pins, then the PR opens.
    const steps: any[] = jobs["version-pr"].steps;
    const at = (test: (step: any) => boolean) => steps.findIndex(test);
    const collect = at((step) => step.with?.pattern === "local-harness-pin-*");
    const apply = at((step) => /local-harness-publication\.mjs apply-pins/.test(step.run ?? ""));
    const gate = at((step) => /check-local-harness-release\.mjs/.test(step.run ?? ""));
    const open = at((step) => step.name === "Open or refresh the version PR");
    expect(collect).toBeGreaterThan(-1);
    expect(collect).toBeLessThan(apply);
    expect(apply).toBeLessThan(gate);
    expect(gate).toBeLessThan(open);
    // The PR says what it pins, and commits a new equivalence record too.
    expect(steps[open].run).toMatch(/packs\.md/);
    expect(steps[open].run).toMatch(/git add mcpjam-inspector\/scripts\/local-harness-pack-equivalence/);
  });

  it("is the only thing that runs the pack pipeline: nothing publishes a pack on a push", () => {
    const callers = readdirSync(workflowsDir)
      .filter((name) => /\.ya?ml$/.test(name))
      .filter((name) =>
        Object.values(parse(readFileSync(new URL(name, workflowsDir), "utf8"))?.jobs ?? {}).some(
          (job: any) => job?.uses === "./.github/workflows/local-harness-pack-pipeline.yml",
        ),
      );
    expect(callers).toEqual(["prepare-release.yml"]);
    expect(Object.keys(workflow("prepare-release").on)).toEqual(["workflow_dispatch"]);
  });

  it("never lets an approval of an older version PR cover new pins", () => {
    // The rulesets keep approvals across pushes, and this PR pins what users
    // download: a regenerated PR with different contents dismisses them first.
    const steps: any[] = workflow("prepare-release").jobs["version-pr"].steps;
    const run: string = steps.find((step) => step.name === "Open or refresh the version PR").run;
    const dismiss = run.indexOf("/dismissals");
    const push = run.indexOf("git push --force");
    expect(dismiss).toBeGreaterThan(-1);
    expect(dismiss).toBeLessThan(push);
    expect(run).toMatch(/HEAD\^\{tree\}/);
  });
});

describe("pack release boundaries", () => {
  const runsAssetCheck = (name: string) =>
    Object.values(workflow(name).jobs)
      .flatMap((job: any) => job.steps ?? [])
      .some((step: any) => /check-local-harness-release\.mjs[^\n]*--assets/.test(step.run ?? ""));

  it("checks the published manifest before versioning a release and before publishing it", () => {
    for (const name of ["prepare-release", "release"]) {
      expect(runsAssetCheck(name), name).toBe(true);
    }
  });

  it("verifies the pinned packs' build provenance wherever it checks their assets", () => {
    for (const name of ["prepare-release", "release"]) {
      const steps = Object.values(workflow(name).jobs).flatMap((job: any) => job.steps ?? []);
      const gate = steps.find((step: any) => /check-local-harness-release\.mjs[^\n]*--assets/.test(step.run ?? ""));
      expect(gate.run, name).toMatch(/--verify-attestations/);
      expect(gate.env?.GH_TOKEN, name).toBeDefined();
    }
  });

  it("does not check published assets on a PR, where they cannot exist yet", () => {
    // Packs publish only from main, so a PR changing a pack input could never
    // pass this and had to merge with the required check red.
    expect(runsAssetCheck("lint")).toBe(false);
  });

  it("reports moved fingerprints on a PR instead of failing it", () => {
    // Merging is what publishes the pack a moved fingerprint describes; the
    // release gate is where a stale record blocks.
    const steps = workflow("lint").jobs.build.steps.filter((step: any) =>
      /check-local-harness-inputs\.mjs/.test(step.run ?? ""),
    );
    expect(steps.map((step: any) => step.run.trim())).toEqual([
      "node mcpjam-inspector/scripts/check-local-harness-inputs.mjs --advisory",
    ]);
    const unit = workflow("local-harness-conformance").jobs.unit.steps.filter((step: any) =>
      /check-local-harness-inputs\.mjs/.test(step.run ?? ""),
    );
    expect(unit.map((step: any) => step.run.trim())).toEqual([
      "node mcpjam-inspector/scripts/check-local-harness-inputs.mjs --advisory",
    ]);
  });

  it("never gives the vendor build job the signing environment or secret", () => {
    const { jobs } = workflow("local-harness-pack");
    expect(jobs.build.environment).toBeUndefined();
    expect(JSON.stringify(jobs.build)).not.toContain("secrets.");
    expect(jobs.sign.environment).toBe("local-harness-pack-release");
    expect(JSON.stringify(jobs.sign)).toContain("secrets.PROTECTED_LOCAL_HARNESS_PACK_SIGNING_KEY");
    expect(jobs.publish.needs).toContain("sign");
    expect(jobs.publish.steps.find((step: any) => step.uses?.startsWith("actions/download-artifact")).with.name).toBe(
      "signed-local-harness-pack-${{ inputs.harness }}-${{ inputs.pack_version }}",
    );
  });

  it("generates the Codex bridge bundle before the Inspector layer that embeds it", () => {
    // The pack workflow runs only on main, so a PR never exercises it: the
    // first automatic run failed every leg because the layer bundler ran
    // without the Codex bundle it imports.
    const runs = workflow("local-harness-pack")
      .jobs.build.steps.map((step: any) => String(step.run ?? ""))
      .join("\n");
    const codex = runs.indexOf("bundle-codex-appserver-bridge.mjs");
    const layer = runs.indexOf("bundle-local-harness-layer.mjs");
    expect(layer).toBeGreaterThan(-1);
    expect(codex).toBeGreaterThan(-1);
    expect(codex).toBeLessThan(layer);
  });

  it("keeps every pack artifact to its own harness and version", () => {
    // Artifact names are run-wide, and the auto workflow builds every harness
    // in one run: an unscoped name collides (409) and an unscoped pattern
    // hands one harness's sign job the other's manifests.
    const { jobs } = workflow("local-harness-pack");
    const scope = "${{ inputs.harness }}";
    const version = "${{ inputs.pack_version }}";
    const artifactSteps = Object.values(jobs)
      .flatMap((job: any) => job.steps ?? [])
      .filter((step: any) => /^actions\/(upload|download)-artifact@/.test(step.uses ?? ""));
    expect(artifactSteps.length).toBeGreaterThanOrEqual(5);
    for (const step of artifactSteps) {
      const key = step.with.name ?? step.with.pattern;
      expect(key, JSON.stringify(step.with)).toContain(scope);
      expect(key, JSON.stringify(step.with)).toContain(version);
    }
  });

  it("ships a runtime contract proven by THIS commit's layer against every selected pack", () => {
    const { jobs } = workflow("release");
    // Evidence for the desired packs and, when the record permits one, the
    // previous ones — both from the conformance workflow, on the release commit.
    expect(jobs["local-harness-evidence"].uses).toBe("./.github/workflows/local-harness-conformance.yml");
    expect(jobs["local-harness-evidence-permitted"].uses).toBe("./.github/workflows/local-harness-conformance.yml");
    expect(jobs["local-harness-evidence-permitted"].with.harnesses).toContain("permitted_harnesses");
    const contract = jobs["local-harness-contract"];
    const runs = contract.steps.map((step: any) => step.run ?? "").join("\n");
    expect(runs).toMatch(/check-local-harness-release\.mjs[\s\S]*--evidence[\s\S]*--contract/);
    expect(contract.steps.some((step: any) => String(step.uses).startsWith("actions/attest-build-provenance"))).toBe(true);
    expect(contract.permissions).toMatchObject({ "id-token": "write", attestations: "write" });
    // No contract, no release: the artifact gate requires it, and the
    // published release carries it.
    expect(jobs["artifact-gate"].needs).toContain("local-harness-contract");
    const finalizeFiles = jobs.finalize.steps
      .filter((step: any) => step.with?.files)
      .map((step: any) => step.with.files)
      .join("\n");
    expect(finalizeFiles).toContain("runtime-contract");
  });

  it("records conformance evidence in every leg, and plans PR legs against the pinned packs", () => {
    const { jobs } = workflow("local-harness-conformance");
    expect(jobs.plan.steps.some((step: any) => /plan-local-harness-conformance\.mjs/.test(step.run ?? ""))).toBe(true);
    for (const name of ["scenarios", "windows", "codex-scenarios"]) {
      const steps = jobs[name].steps;
      expect(steps.some((step: any) => /write-conformance-evidence\.mjs/.test(step.run ?? "")), name).toBe(true);
      expect(
        steps.some((step: any) => String(step.with?.name ?? "").startsWith("conformance-evidence-")),
        name,
      ).toBe(true);
      expect(jobs[name].needs, name).toContain("plan");
    }
  });

  it("attests what it signs, and adopts or finishes what already exists instead of refusing", () => {
    const { jobs, on } = workflow("local-harness-pack");
    expect(on.workflow_call.inputs.publish.default).toBe("always");
    expect(jobs.sign.permissions).toMatchObject({ "id-token": "write", attestations: "write" });
    const attest = jobs.sign.steps.find((step: any) => String(step.uses).startsWith("actions/attest-build-provenance"));
    expect(attest.with["subject-path"]).toMatch(/\.tar\.gz/);
    expect(attest.with["subject-path"]).toMatch(/\.manifest\.json/);
    expect(jobs.preflight.steps.some((step: any) => /local-harness-publication\.mjs existing/.test(step.run ?? ""))).toBe(true);
    expect(jobs.build.if).toBe("needs.preflight.outputs.state == 'none'");
    expect(jobs["finish-draft"].if).toMatch(/state == 'draft'/);
    // A build that reproduced the pinned bytes publishes nothing.
    expect(jobs.sign.if).toMatch(/equivalent != 'true'/);
    expect(jobs.publish.if).toMatch(/equivalent != 'true'/);
    // The build checks the install is the locked one; whether the inputs were
    // REVIEWED is the version PR's question.
    const builds = jobs.build.steps.map((step: any) => step.run ?? "").join("\n");
    expect(builds).toMatch(/check-local-harness-inputs\.mjs --drift/);
  });

  it("pipelines plan → pack → conformance → a pin handed to the release, and reports failures", () => {
    const { jobs } = workflow("local-harness-pack-pipeline");
    expect(jobs.plan.steps.some((step: any) => /local-harness-publication\.mjs plan/.test(step.run ?? ""))).toBe(true);
    expect(jobs.pack.uses).toBe("./.github/workflows/local-harness-pack.yml");
    expect(jobs.pack.with.publish).toBe("unless-equivalent");
    expect(jobs["candidate-conformance"].uses).toBe("./.github/workflows/local-harness-conformance.yml");
    expect(jobs["candidate-conformance"].with.candidate).toBe(true);
    expect(jobs.pin.if).toMatch(/candidate-conformance\.result == 'success'/);
    const pinRuns = jobs.pin.steps.map((step: any) => step.run ?? "").join("\n");
    expect(pinRuns).toMatch(/local-harness-publication\.mjs intent[\s\S]*--kind pin[\s\S]*--conformance/);
    // Every outcome hands the release one artifact per harness: up to date
    // (plan), an equivalence record, or a pin.
    for (const job of ["plan", "equivalence", "pin"]) {
      const upload = jobs[job].steps.find((step: any) => String(step.uses).startsWith("actions/upload-artifact@"));
      expect(upload?.with.name, job).toBe("local-harness-pin-${{ inputs.harness }}");
    }
    // The pipeline writes nothing to main and opens no PR of its own.
    const text = JSON.stringify(jobs);
    expect(text).not.toContain("local-harness-bot-pr.sh");
    expect(text).not.toContain("RELEASE_PUSH_TOKEN");
    // No install where provenance can be minted or pins are decided.
    for (const job of ["equivalence", "pin"]) {
      const runs = jobs[job].steps.map((step: any) => step.run ?? "").join("\n");
      expect(runs, job).not.toMatch(/npm (ci|install)/);
    }
    // The equivalence record is attested before it is handed over.
    const equivalence = jobs.equivalence.steps;
    expect(equivalence.some((step: any) => String(step.uses).startsWith("actions/attest-build-provenance"))).toBe(true);
    expect(jobs.report.if).toBe("always()");
    expect(jobs.report.permissions.issues).toBe("write");
  });
});
