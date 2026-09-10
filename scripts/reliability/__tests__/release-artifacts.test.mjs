import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordManifest, verifyManifest } from "../release-artifacts.mjs";

test("manifest binds verified bytes to candidate SHA and detects tampering", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-manifest-test-"));
  try {
    writeFileSync(path.join(dir, "mcpjam-sdk-1.0.0.tgz"), "tested bytes");
    recordManifest(dir, "candidate-sha", [
      {
        filename: "mcpjam-sdk-1.0.0.tgz",
        name: "@mcpjam/sdk",
        version: "1.0.0",
        publish: true,
      },
    ]);
    assert.equal(verifyManifest(dir, "candidate-sha").packages.length, 1);
    assert.throws(() => verifyManifest(dir, "other-sha"), /identity/);
    writeFileSync(path.join(dir, "mcpjam-sdk-1.0.0.tgz"), "rebuilt bytes");
    assert.throws(() => verifyManifest(dir, "candidate-sha"), /integrity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest refuses invalid package identities, duplicate names and path escapes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-manifest-test-"));
  const valid = {
    filename: "mcpjam-sdk-1.0.0.tgz",
    name: "@mcpjam/sdk",
    version: "1.0.0",
    publish: true,
  };
  try {
    writeFileSync(path.join(dir, valid.filename), "bytes");
    const recorded = recordManifest(dir, "sha", [valid]);
    for (const packages of [
      [{ ...recorded.packages[0], filename: "../escape.tgz" }],
      [{ ...recorded.packages[0], name: "@other/sdk" }],
      [...recorded.packages, ...recorded.packages],
      [{ ...recorded.packages[0], publish: "false" }],
      [{ ...recorded.packages[0], version: "latest" }],
    ]) {
      writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ ...recorded, packages })
      );
      assert.throws(() => verifyManifest(dir, "sha"), /Invalid/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publishes selected packages only, tolerates visibility delay and makes retries idempotent", async () => {
  const { publishManifest } = await import("../release-artifacts.mjs");
  const pkg = {
    name: "@mcpjam/sdk",
    version: "1.0.0",
    filename: "mcpjam-sdk-1.0.0.tgz",
    publish: true,
    integrity: "sha512-tested",
  };
  let writes = 0;
  let reads = 0;
  const options = {
    publish: async () => {
      writes++;
    },
    readDist: async () => (++reads < 3 ? null : { integrity: pkg.integrity }),
    sleep: async () => {},
  };
  await publishManifest(
    { packages: [pkg, { ...pkg, name: "support-sdk", publish: false }] },
    "/tmp",
    options
  );
  assert.equal(writes, 1);
  await publishManifest({ packages: [pkg] }, "/tmp", options);
  assert.equal(writes, 1);
  await assert.rejects(
    publishManifest({ packages: [pkg] }, "/tmp", {
      ...options,
      readDist: async () => ({ integrity: "sha512-other" }),
    }),
    /differ/
  );
  assert.equal(writes, 1);
});
