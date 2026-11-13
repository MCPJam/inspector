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
//                  The workflow passes this itself: `github.event_name` in a
//                  called run is the caller's.
//   push / dispatch with no version
//                  Packs built from source on every platform, as before.
//                  A push that changed no conformance input (a version PR's
//                  lockfile bump, say) runs no legs: its parent's run already
//                  proved the same thing, and the legs would compete for the
//                  macOS runners the release's own evidence run needs. A run
//                  that names a pack version always runs: no push run checked
//                  that pack.
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
// Claude Code and Codex have drivers and legs of their own. Every other local
// runtime runs `run-gateway-turn.ts <harnessId>` on each target its definition
// advertises (`runtime_matrix`), so a runtime made local is covered with no
// change here. A workflow_call that names no version for one runs nothing for
// it: a release needs evidence only for the packs it may select.
//
// Prints `key=value` lines for `$GITHUB_OUTPUT`.
import { pathToFileURL } from "node:url";
import { computeConformanceInputsDigest } from "./conformance-inputs-digest.mjs";
import { listPackHarnessIds } from "./local-harness-pack-harnesses.mjs";
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

const OWN_DRIVERS = new Set(["claude-code", "codex"]);
// Each target's runner, from the one table above that lists all five.
const RUNNERS = Object.fromEntries(CODEX_LEGS.map(({ platform_key, ...runner }) => [platform_key, runner]));
const PACK_VERSION = /^\d+\.\d+\.\d+$/;

/** `copilot-cli=1.0.0,cursor=1.2.0` as a map, refusing anything else. */
function parseRuntimeVersions(text, runtimes) {
  const versions = new Map();
  for (const pair of (text ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const [harnessId, version, extra] = pair.split("=");
    if (!runtimes.includes(harnessId) || extra !== undefined) throw new Error(`not a local runtime's pack: ${pair}`);
    if (!PACK_VERSION.test(version ?? "")) throw new Error(`not a pack version: ${version}`);
    versions.set(harnessId, version);
  }
  return versions;
}

function desiredVersion(record, harnessId) {
  const slot = Object.values(record.harnesses[harnessId]?.targets ?? {})[0];
  return slot?.desired.packVersion ?? "";
}

/**
 * @param {{ event: string, claudeVersion?: string, codexVersion?: string,
 *           runtimeVersions?: string, harnesses?: string, certifiedOnly?: boolean,
 *           inputsUnchanged?: boolean,
 *           record?: ReturnType<typeof readRuntimeCompat>,
 *           facts?: ReturnType<typeof readManifestFacts> }} input
 */
export function planConformance(input) {
  const record = input.record ?? readRuntimeCompat();
  const facts = input.facts ?? readManifestFacts();
  const packHarnesses = listPackHarnessIds();
  const selected = new Set(
    (input.harnesses || packHarnesses.join(",")).split(",").map((id) => id.trim()).filter(Boolean),
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
  const proven =
    input.event === "push" &&
    input.inputsUnchanged === true &&
    !input.claudeVersion &&
    !input.codexVersion &&
    !input.runtimeVersions;
  // Every other runtime: one leg per target it advertises, so each is certified.
  const runtimes = packHarnesses.filter((id) => !OWN_DRIVERS.has(id));
  const named = parseRuntimeVersions(input.runtimeVersions, runtimes);
  const runtimeLegs = runtimes
    .filter((id) => !proven && selected.has(id) && (input.event !== "workflow_call" || named.has(id)))
    .flatMap((id) =>
      advertisedTargetsOf(facts[id]).map((target) => ({
        harness: id,
        platform_key: target,
        ...RUNNERS[target],
        pack_version: version(id, named.get(id)),
      })),
    )
    .filter((leg) => !pullRequest || leg.platform_key === "linux-x64");
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
    runtime_matrix: JSON.stringify(runtimeLegs),
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
    runtimeVersions: process.env.RUNTIME_INPUT ?? "",
    harnesses: process.env.HARNESSES ?? "",
    certifiedOnly: process.env.CERTIFIED_ONLY === "true",
    inputsUnchanged,
  });
  for (const [key, value] of Object.entries(plan)) process.stdout.write(`${key}=${value}\n`);
}
