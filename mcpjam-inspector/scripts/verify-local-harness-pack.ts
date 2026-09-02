/**
 * Install a freshly built pack through the real installer and fail if it does
 * not come out `ready`.
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

const expectedDigest = process.argv[2];

const result = await installRuntimePack({ harnessId: "claude-code" });
console.log(JSON.stringify(result, null, 2));

if (result.state !== "ready") {
  console.error(
    `verify-local-harness-pack: the built pack did not install (${result.state})`,
  );
  process.exit(1);
}
if (expectedDigest !== undefined && result.digest !== expectedDigest) {
  console.error(
    `verify-local-harness-pack: installed digest ${result.digest} is not the ` +
      `digest the build reported (${expectedDigest})`,
  );
  process.exit(1);
}
console.log("verify-local-harness-pack: ok");
