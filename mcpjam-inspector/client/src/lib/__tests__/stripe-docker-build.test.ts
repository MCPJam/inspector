import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("supplies the public Stripe key to the Vite Docker build", () => {
  const docker = readFileSync("Dockerfile", "utf8");
  expect(docker).toMatch(/^ARG VITE_STRIPE_PUBLISHABLE_KEY$/m);
  expect(docker).toMatch(/export VITE_STRIPE_PUBLISHABLE_KEY/);
});
