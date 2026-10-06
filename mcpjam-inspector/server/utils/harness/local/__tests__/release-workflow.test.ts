import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const workflow = (name: string) => parse(readFileSync(new URL(`../../../../../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

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
    expect(jobs.publish.steps.find((step: any) => step.uses?.startsWith("actions/download-artifact")).with.name).toBe("signed-local-harness-pack");
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
    // REVIEWED is the pin PR's question.
    const builds = jobs.build.steps.map((step: any) => step.run ?? "").join("\n");
    expect(builds).toMatch(/check-local-harness-inputs\.mjs --drift/);
  });

  it("publishes automatically, one harness at a time, never cancelling a run in flight", () => {
    const auto = workflow("local-harness-pack-auto");
    expect(auto.on.push.branches).toEqual(["main"]);
    expect(auto.on.workflow_dispatch.inputs.harness).toBeDefined();
    const publish = auto.jobs.publish;
    expect(publish.uses).toBe("./.github/workflows/local-harness-pack-pipeline.yml");
    expect(publish.concurrency).toEqual({
      group: "local-harness-pack-auto-${{ matrix.harness }}",
      "cancel-in-progress": false,
    });
    expect(publish.strategy["fail-fast"]).toBe(false);
  });

  it("pipelines plan → pack → conformance → one pin PR per harness, and reports failures", () => {
    const { jobs } = workflow("local-harness-pack-pipeline");
    expect(jobs.plan.steps.some((step: any) => /local-harness-publication\.mjs plan/.test(step.run ?? ""))).toBe(true);
    expect(jobs.pack.uses).toBe("./.github/workflows/local-harness-pack.yml");
    expect(jobs.pack.with.publish).toBe("unless-equivalent");
    expect(jobs["candidate-conformance"].uses).toBe("./.github/workflows/local-harness-conformance.yml");
    expect(jobs["candidate-conformance"].with.candidate).toBe(true);
    expect(jobs.pin.if).toMatch(/candidate-conformance\.result == 'success'/);
    const pinRuns = jobs.pin.steps.map((step: any) => step.run ?? "").join("\n");
    expect(pinRuns).toMatch(/write-pack-digests\.mjs[\s\S]*--conformance[\s\S]*--evidence/);
    expect(pinRuns).toMatch(/check-local-harness-inputs\.mjs --write --harness/);
    expect(pinRuns).toMatch(/local-harness-bot-pr\.sh/);
    // Pushed with the release token, so the PR's checks run at all.
    expect(JSON.stringify(jobs.pin)).toContain("secrets.RELEASE_PUSH_TOKEN");
    // The equivalence record is attested before it is committed.
    const equivalence = jobs.equivalence.steps;
    expect(equivalence.some((step: any) => String(step.uses).startsWith("actions/attest-build-provenance"))).toBe(true);
    expect(jobs.report.if).toBe("always()");
    expect(jobs.report.permissions.issues).toBe("write");
  });
});
