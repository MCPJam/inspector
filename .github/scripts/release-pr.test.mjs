import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseReleaseOptions,
  renderReleaseOptions,
  versionPrBody,
  versionPrTitle,
} from "./release-pr.mjs";

const releases = [
  { name: "@mcpjam/inspector", type: "patch", oldVersion: "3.12.2", newVersion: "3.12.3" },
  { name: "@mcpjam/sdk", type: "minor", oldVersion: "8.17.0", newVersion: "8.18.0" },
  { name: "@mcpjam/mcp", type: "none", oldVersion: "0.0.1", newVersion: "0.0.1" },
];

test("titles the PR with the Inspector version when it ships", () => {
  assert.equal(versionPrTitle(releases), "chore(release): version packages (3.12.3)");
});

test("titles a packages-only PR with each bumped package", () => {
  assert.equal(
    versionPrTitle(releases.slice(1)),
    "chore(release): version packages (@mcpjam/sdk 8.18.0)"
  );
});

test("options survive a round trip through the body", () => {
  for (const options of [
    { deploy_backend_prod: true, deploy_webapp: true, skip_verify: true },
    { deploy_backend_prod: false, deploy_webapp: true, skip_verify: false },
    { deploy_backend_prod: false, deploy_webapp: false, skip_verify: false },
  ]) {
    const body = versionPrBody({ releases, options, runUrl: "https://x", sourceSha: "abc" });
    assert.deepEqual(parseReleaseOptions(body), options);
  }
});

test("reads a box ticked in the GitHub UI", () => {
  const body = renderReleaseOptions({ deploy_backend_prod: false, deploy_webapp: false })
    .replace("- [ ] Deploy the backend", "- [x] Deploy the backend");
  assert.deepEqual(parseReleaseOptions(body), {
    deploy_backend_prod: true,
    deploy_webapp: false,
    skip_verify: false,
  });
});

test("a missing or mangled option reads as unchecked", () => {
  assert.deepEqual(parseReleaseOptions(null), {
    deploy_backend_prod: false,
    deploy_webapp: false,
    skip_verify: false,
  });
  assert.deepEqual(
    parseReleaseOptions("- [x] Deploy the webapp to production\n[x] <!-- release-option:deploy_backend_prod -->"),
    { deploy_backend_prod: false, deploy_webapp: false, skip_verify: false }
  );
});

test("ignores options it does not know", () => {
  assert.deepEqual(parseReleaseOptions("- [x] Nuke it <!-- release-option:nuke -->"), {
    deploy_backend_prod: false,
    deploy_webapp: false,
    skip_verify: false,
  });
});

test("a packages-only PR never offers the webapp deploy ticked", () => {
  const body = versionPrBody({
    releases: releases.slice(1),
    options: { deploy_backend_prod: true, deploy_webapp: true, skip_verify: false },
    runUrl: "https://x",
    sourceSha: "abc",
  });
  assert.deepEqual(parseReleaseOptions(body), {
    deploy_backend_prod: true,
    deploy_webapp: false,
    skip_verify: false,
  });
});
