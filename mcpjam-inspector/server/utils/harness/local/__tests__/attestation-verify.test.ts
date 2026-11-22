import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import { verifyAttestation } from "../../../../../scripts/local-harness-publication.mjs";

// A stand-in `gh` on PATH. It records overlapping runs (mkdir is atomic), and
// answers by the asset's name: `init-*` fails to start the verifier on its
// first call, `bad-*` is a real verdict, anything else verifies.
const FAKE_GH = `#!/usr/bin/env bash
dir="$FAKE_GH_DIR"
echo "$3" >> "$dir/calls"
if ! mkdir "$dir/lock" 2>/dev/null; then echo overlap >> "$dir/overlaps"; fi
sleep 0.05
rmdir "$dir/lock" 2>/dev/null
name="$(basename "$3")"
case "$name" in
  init-*)
    if [ ! -f "$dir/init-seen-$name" ]; then
      touch "$dir/init-seen-$name"
      echo "Error: failed to choose verifier based on provided bundle issuer: public good verifier is not available (initialization may have failed)" >&2
      exit 1
    fi ;;
  bad-*) echo "Error: verifying with issuer: no matching attestation" >&2; exit 1 ;;
esac
exit 0
`;

// Release tooling that runs on the Linux pack pipeline. Windows would not run
// the bash stand-in as `gh`, and the real `gh` on PATH would answer instead.
describe.skipIf(process.platform === "win32")("verifyAttestation", () => {
  let dir: string;
  let path: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
    writeFileSync(join(dir, "gh"), FAKE_GH);
    chmodSync(join(dir, "gh"), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    process.env.FAKE_GH_DIR = dir;
  });

  afterEach(() => {
    process.env.PATH = path;
    delete process.env.FAKE_GH_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const options = { repo: "MCPJam/inspector", workflow: ".github/workflows/local-harness-pack.yml" };
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  it("runs one verification at a time and retries a verifier that failed to start", async () => {
    const results = await Promise.all(
      ["init-a.tar.gz", "ok-b.tar.gz", "init-c.json"].map((name) =>
        verifyAttestation(join(dir, name), options, { backoffMs: 1 }),
      ),
    );
    expect(results).toEqual([null, null, null]);
    expect(read("overlaps")).toEqual([]);
    expect(read("calls")).toHaveLength(5);
  });

  it("reports a real verdict without retrying it", async () => {
    const failure = await verifyAttestation(join(dir, "bad-d.tar.gz"), options, { backoffMs: 1 });
    expect(failure).toMatch(/no matching attestation/);
    expect(read("calls")).toHaveLength(1);
  });
});
