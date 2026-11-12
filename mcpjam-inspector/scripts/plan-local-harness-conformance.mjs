// Which local-harness conformance legs run, against which packs — the `plan`
// job of `.github/workflows/local-harness-conformance.yml`, as a script so
// the rule is one tested function rather than YAML expressions.
//
//   pull_request   This PR's Inspector layer against the PINNED published
//                  (desired) pack, Linux x64 only. Nothing has to be
//                  published for it to pass, so a PR can never deadlock on a
//                  pack that only main can publish.
//   workflow_call  The versions the caller names (a release asks for its
//                  desired packs, then its permitted ones), every platform.
//                  `harnesses` limits the run to the harnesses that have one.
//   push / dispatch with no version
//                  Packs built from source on every platform, as before.
//                  A push that changed no conformance input (a version PR's
//                  lockfile bump, say) runs no legs: its parent's run already
//                  proved the same thing, and the legs would compete for the
//                  macOS runners the release's own evidence run needs.
//
// `certifiedOnly` drops the legs for targets a harness does not advertise.
// Those legs exist so their evidence stays visible, and a push to main still
// runs them; a release needs evidence only for what it offers.
//
// darwin-x64 runs on an Apple Silicon runner, with x64 Node under Rosetta 2:
// every process in the leg, the vendor CLI included, is an x86_64 binary on
// the same Darwin kernel an Intel Mac runs. The Intel runners took two to
// three times as long and GitHub retires them in 2027.
//
// Prints `key=value` lines for `$GITHUB_OUTPUT`.
import { pathToFileURL } from "node:url";
import { computeConformanceInputsDigest } from "./conformance-inputs-digest.mjs";
import { advertisedTargetsOf, readManifestFacts, readRuntimeCompat } from "./local-harness-pack-tables.mjs";

const DARWIN_X64 = { runner: "macos-latest", node_arch: "x64" };
const POSIX_LEGS = [
  { label: "linux-x64 scenarios", runner: "ubuntu-latest", platform_key: "linux-x64", node_dist: "linux-x64" },
  { label: "darwin-x64 scenarios", ...DARWIN_X64, platform_key: "darwin-x64", node_dist: "darwin-x64" },
  { label: "linux-arm64 scenarios", runner: "ubuntu-24.04-arm", platform_key: "linux-arm64", node_dist: "linux-arm64" },
  { label: "darwin-arm64 scenarios", runner: "macos-latest", platform_key: "darwin-arm64", node_dist: "darwin-arm64" },
];
const CODEX_LEGS = [
  { platform_key: "linux-x64", runner: "ubuntu-latest", node_dist: "linux-x64" },
  { platform_key: "darwin-arm64", runner: "macos-latest", node_dist: "darwin-arm64" },
  { platform_key: "linux-arm64", runner: "ubuntu-24.04-arm", node_dist: "linux-arm64" },
  { platform_key: "darwin-x64", ...DARWIN_X64, node_dist: "darwin-x64" },
  { platform_key: "win32-x64", runner: "windows-latest", node_dist: "win-x64" },
];

function desiredVersion(record, harnessId) {
  const slot = Object.values(record.harnesses[harnessId]?.targets ?? {})[0];
  return slot?.desired.packVersion ?? "";
}

/**
 * @param {{ event: string, claudeVersion?: string, codexVersion?: string,
 *           harnesses?: string, certifiedOnly?: boolean,
 *           inputsUnchanged?: boolean,
 *           record?: ReturnType<typeof readRuntimeCompat>,
 *           facts?: ReturnType<typeof readManifestFacts> }} input
 */
export function planConformance(input) {
  const record = input.record ?? readRuntimeCompat();
  const facts = input.facts ?? readManifestFacts();
  const selected = new Set(
    (input.harnesses || "claude-code,codex").split(",").map((id) => id.trim()).filter(Boolean),
  );
  const pullRequest = input.event === "pull_request";
  const version = (harnessId, given) =>
    given && given.length > 0 ? given : pullRequest ? desiredVersion(record, harnessId) : "";
  for (const given of [input.claudeVersion, input.codexVersion]) {
    if (given && !/^\d+\.\d+\.\d+$/.test(given)) throw new Error(`not a pack version: ${given}`);
  }
  // D8: a leg blocks exactly when its target is one the harness's manifest
  // advertises — the targets the release gate requires evidence for.
  const legsFor = (harnessId, legs) => {
    const advertised = new Set(advertisedTargetsOf(facts[harnessId]));
    return legs
      .map((leg) => ({ ...leg, certified: advertised.has(leg.platform_key) }))
      .filter((leg) => !input.certifiedOnly || leg.certified)
      .filter((leg) => !pullRequest || leg.platform_key === "linux-x64");
  };
  const proven = input.event === "push" && input.inputsUnchanged === true;
  return {
    claude_pack_version: version("claude-code", input.claudeVersion),
    codex_pack_version: version("codex", input.codexVersion),
    run_claude: String(selected.has("claude-code") && !proven),
    run_codex: String(selected.has("codex") && !proven),
    // `summarize` stamps Claude Code's version only once Windows passed, so
    // `certifiedOnly` never skips this leg.
    run_windows: String(selected.has("claude-code") && !pullRequest && !proven),
    posix_matrix: JSON.stringify(legsFor("claude-code", POSIX_LEGS)),
    codex_matrix: JSON.stringify(legsFor("codex", CODEX_LEGS)),
  };
}

/**
 * Whether a push left every conformance input as main's previous tip had it.
 * Compared with that tip, not the parent: one push can land several commits.
 * A tip this checkout cannot read counts as changed, so every leg runs.
 */
function unchangedSince(before) {
  if (!/^[0-9a-f]{40}$/.test(before) || /^0+$/.test(before)) return false;
  let previous;
  try {
    previous = computeConformanceInputsDigest({ rev: before });
  } catch (error) {
    process.stderr.write(`Could not read ${before} (${error instanceof Error ? error.message : String(error)}); every leg runs.\n`);
    return false;
  }
  return previous === computeConformanceInputsDigest();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const event = process.env.EVENT ?? "";
  const inputsUnchanged = event === "push" && unchangedSince(process.env.BEFORE ?? "");
  if (inputsUnchanged) process.stderr.write("No conformance input changed in this push; no legs run.\n");
  const plan = planConformance({
    event,
    claudeVersion: process.env.CLAUDE_INPUT ?? "",
    codexVersion: process.env.CODEX_INPUT ?? "",
    harnesses: process.env.HARNESSES ?? "",
    certifiedOnly: process.env.CERTIFIED_ONLY === "true",
    inputsUnchanged,
  });
  for (const [key, value] of Object.entries(plan)) process.stdout.write(`${key}=${value}\n`);
}
