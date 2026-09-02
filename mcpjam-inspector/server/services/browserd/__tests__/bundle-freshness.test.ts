/**
 * The checked-in daemon bundle must be REGENERATED whenever daemon sources
 * change. Nothing in `build`, `pretest`, CI, or the Dockerfile runs
 * `bundle:browserd` (the #4485 wiring was deliberately reverted in #4486), so
 * without this test a daemon edit that forgets `npm run bundle:browserd`
 * ships a silently stale daemon: the server uploads the OLD embedded bytes
 * into every sandbox while the repo shows the new code.
 *
 * Two assertions:
 *   1. the source hash stamped into the generated file at bundle time equals
 *      a hash freshly derived from the live daemon sources (algorithm
 *      duplicated from scripts/bundle-browserd.mjs — keep in lockstep);
 *   2. the embedded base64 decodes byte-identical to the checked-in `.mjs`,
 *      so the artifact the server uploads is the artifact in review.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MCPJAM_BROWSERD_BUNDLE_BASE64,
  MCPJAM_BROWSERD_SOURCE_HASH,
} from "../dist/mcpjam-browserd-bundle.generated";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const daemonDir = resolve(root, "server/services/browserd/daemon");
const protocolFile = resolve(root, "server/services/browserd/protocol.ts");
const bundleFile = resolve(
  root,
  "server/services/browserd/dist/mcpjam-browserd.mjs",
);

/** Mirror of `computeDaemonSourceHash` in scripts/bundle-browserd.mjs. */
function computeDaemonSourceHash(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".ts")) files.push(full);
    }
  };
  walk(daemonDir);
  files.push(protocolFile);
  files.sort((a, b) => (relative(root, a) < relative(root, b) ? -1 : 1));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

describe("browserd bundle freshness", () => {
  it("the checked-in bundle was generated from the current daemon sources", () => {
    expect(
      MCPJAM_BROWSERD_SOURCE_HASH,
      "daemon sources changed after the last `npm run bundle:browserd` — " +
        "regenerate and commit BOTH dist files in the same commit",
    ).toBe(computeDaemonSourceHash());
  });

  it("the embedded base64 is byte-identical to the checked-in .mjs", () => {
    const embedded = Buffer.from(MCPJAM_BROWSERD_BUNDLE_BASE64, "base64");
    const artifact = readFileSync(bundleFile);
    expect(embedded.equals(artifact)).toBe(true);
  });
});
