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

  it("does not check published assets on a PR, where they cannot exist yet", () => {
    // Packs publish only from main, so a PR changing a pack input could never
    // pass this and had to merge with the required check red.
    expect(runsAssetCheck("lint")).toBe(false);
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
});

