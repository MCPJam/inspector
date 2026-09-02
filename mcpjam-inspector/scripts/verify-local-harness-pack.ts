/**
 * Install a freshly built pack through the real installer and fail if it does
 * not come out `ready`.
 *
 * The expected digest is passed in and exported as
 * `MCPJAM_LOCAL_HARNESS_EXPECTED_PACK`, because the generated digest table
 * cannot name this pack: the build that just ran is what produced the digest.
 * Without that, this step could only ever verify a pack from a previous
 * release — not the artifact about to be published.
 *
 * Run in CI immediately after the pack build, against the pack's own archive.
 * It is the difference between "the build produced files" and "the code that
 * runs on a user's machine accepts them": signature handling, archive hash,
 * extraction filtering and the tree digest are all exercised here, so a pack
 * that would fail on a laptop never reaches a release.
 *
 *   MCPJAM_RUNTIME_ROOT=<scratch> \
 *   MCPJAM_LOCAL_HARNESS_PACK_SOURCE=<path to .tar.gz> \
 *   npx tsx scripts/verify-local-harness-pack.ts <expected tree digest>
 */
import { installRuntimePack } from "../server/utils/harness/local/runtime-install.js";

// Required, not optional. The digest is the ONE thing tying the pack that just
// installed to the artifact this build produced; treating its absence as
// "skip the check" meant a mis-wired CI step could print `ok` having verified
// that some pack, possibly from a previous release, installs.
const expectedDigest = process.argv[2];
const packVersion = process.argv[3] ?? "verify";
if (
  expectedDigest === undefined ||
  !/^sha256:[0-9a-f]{64}$/.test(expectedDigest)
) {
  console.error(
    "verify-local-harness-pack: expected a tree digest as the first " +
      "argument, e.g. sha256:<64 hex>",
  );
  process.exit(1);
}
process.env.MCPJAM_LOCAL_HARNESS_EXPECTED_PACK = `${packVersion}:${expectedDigest}`;

const result = await installRuntimePack({ harnessId: "claude-code" });
console.log(JSON.stringify(result, null, 2));

if (result.state !== "ready") {
  console.error(
    `verify-local-harness-pack: the built pack did not install (${result.state})`,
  );
  process.exit(1);
}
if (result.digest !== expectedDigest) {
  console.error(
    `verify-local-harness-pack: installed digest ${result.digest} is not the ` +
      `digest the build reported (${expectedDigest})`,
  );
  process.exit(1);
}
console.log("verify-local-harness-pack: ok");
