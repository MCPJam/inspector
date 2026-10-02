import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const workflow = (name: string) => parse(readFileSync(new URL(`../../../../../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

describe("pack release boundaries", () => {
  it("checks the published manifest in the required build and before versioning a release", () => {
    for (const name of ["lint", "prepare-release"]) {
      const steps = Object.values(workflow(name).jobs).flatMap((job: any) => job.steps ?? []);
      expect(steps.some((step: any) => /check-local-harness-release\.mjs --assets/.test(step.run ?? ""))).toBe(true);
    }
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
