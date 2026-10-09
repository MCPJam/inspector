import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("supplies the public Stripe key to the Vite Docker build", () => {
  const docker = readFileSync("Dockerfile", "utf8");
  expect(docker).toMatch(/^ARG VITE_STRIPE_PUBLISHABLE_KEY$/m);
  expect(docker).toMatch(/export VITE_STRIPE_PUBLISHABLE_KEY/);
});

it("supplies the analytics environment to hosted Vite builds", () => {
  const docker = readFileSync("Dockerfile", "utf8");
  expect(docker).toMatch(/^ARG VITE_ENVIRONMENT$/m);
  expect(docker).toMatch(/export VITE_ENVIRONMENT/);

  const stagingWorkflow = readFileSync(
    "../.github/workflows/deploy-staging.yml",
    "utf8",
  );
  expect(stagingWorkflow).toContain("VITE_ENVIRONMENT=staging");

  const previewWorkflow = readFileSync(
    "../.github/workflows/pr-preview.yml",
    "utf8",
  );
  expect(previewWorkflow.match(/VITE_ENVIRONMENT=preview/g)).toHaveLength(3);
});
