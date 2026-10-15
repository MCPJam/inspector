// release.yml's preflight plan: what one run ships, including the desktop-only
// completion of an Inspector release whose desktop build failed after npm.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { githubReleaseExists, planRelease } from "./release-plan.mjs";

const inspector = (newVersion = "3.15.0") => ({ name: "@mcpjam/inspector", newVersion });

test("an Inspector release publishes and builds the desktop apps", () => {
  const plan = planRelease({
    unpublished: [inspector(), { name: "@mcpjam/sdk", newVersion: "9.0.0" }],
    inspectorVersion: "3.15.0",
    inspectorReleaseExists: false,
  });
  assert.equal(plan.scope, "full");
  assert.equal(plan.publish_any, "true");
  assert.equal(plan.publish_inspector, "true");
  assert.equal(plan.build_inspector_artifacts, "true");
  assert.equal(plan.desktop_only, "false");
  assert.equal(plan.release_tag, "v3.15.0");
});

test("a packages-only release builds no desktop apps and makes no GitHub release", () => {
  const plan = planRelease({
    unpublished: [{ name: "@mcpjam/cli", newVersion: "4.0.1" }],
    inspectorVersion: "3.14.0",
    inspectorReleaseExists: true,
  });
  assert.equal(plan.scope, "packages-only");
  assert.equal(plan.build_inspector_artifacts, "false");
  assert.equal(plan.release_tag, "");
});

test("completes an Inspector release whose desktop build failed after npm: desktop-only", () => {
  const plan = planRelease({ unpublished: [], inspectorVersion: "3.15.0", inspectorReleaseExists: false });
  assert.equal(plan.scope, "desktop-only");
  assert.equal(plan.desktop_only, "true");
  assert.equal(plan.publish_any, "false");
  assert.equal(plan.publish_inspector, "false");
  assert.equal(plan.build_inspector_artifacts, "true");
  assert.equal(plan.inspector_version, "3.15.0");
  assert.equal(plan.release_tag, "v3.15.0");
  // A retry that ticked deploy_webapp does not fail; the deploy itself
  // needs a publish, which a desktop-only run never makes.
  assert.doesNotThrow(() =>
    planRelease({ unpublished: [], inspectorVersion: "3.15.0", inspectorReleaseExists: false, deployWebapp: true }),
  );
});

test("refuses when everything is already released", () => {
  assert.throws(
    () => planRelease({ unpublished: [], inspectorVersion: "3.14.0", inspectorReleaseExists: true }),
    /Nothing to release/,
  );
});

test("refuses a webapp deploy with no Inspector release", () => {
  assert.throws(
    () =>
      planRelease({
        unpublished: [{ name: "@mcpjam/sdk", newVersion: "9.0.0" }],
        inspectorVersion: "3.14.0",
        inspectorReleaseExists: true,
        deployWebapp: true,
      }),
    /requires an inspector release/,
  );
});

test("tells a missing GitHub release from an error it cannot read", () => {
  const ok = () => ({ status: 0, stdout: "v3.14.0\n", stderr: "" });
  const missing = () => ({ status: 1, stdout: "", stderr: "release not found\n" });
  const broken = () => ({ status: 1, stdout: "", stderr: "HTTP 502\n" });
  assert.equal(githubReleaseExists("v3.14.0", ok), true);
  assert.equal(githubReleaseExists("v3.15.0", missing), false);
  // Fails closed: an unreadable answer never reads as "missing", which would
  // start a desktop-only release for a version that already has one.
  assert.throws(() => githubReleaseExists("v3.15.0", broken), /Could not tell/);
});
