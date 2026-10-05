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
});
