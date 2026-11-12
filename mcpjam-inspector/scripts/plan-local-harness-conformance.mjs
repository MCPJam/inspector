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
//
// Claude Code and Codex have drivers and legs of their own. Every other local
// runtime runs `run-gateway-turn.ts <harnessId>` on each target its definition
// advertises (`runtime_matrix`), so a runtime made local is covered with no
// change here. A workflow_call that names no version for one runs nothing for
// it: a release needs evidence only for the packs it may select.
//
// Prints `key=value` lines for `$GITHUB_OUTPUT`.
import { pathToFileURL } from "node:url";
import { listPackHarnessIds } from "./local-harness-pack-harnesses.mjs";
import { readAdvertisedTargets, readRuntimeCompat } from "./local-harness-pack-tables.mjs";

const POSIX_LEGS = [
  { label: "linux-x64 scenarios", runner: "ubuntu-latest", platform_key: "linux-x64", node_dist: "linux-x64" },
  { label: "darwin-x64 scenarios", runner: "macos-15-intel", platform_key: "darwin-x64", node_dist: "darwin-x64" },
  { label: "linux-arm64 scenarios", runner: "ubuntu-24.04-arm", platform_key: "linux-arm64", node_dist: "linux-arm64" },
  { label: "darwin-arm64 scenarios", runner: "macos-latest", platform_key: "darwin-arm64", node_dist: "darwin-arm64" },
];
// D8: the targets Codex's manifest certifies block; the others run so their
// evidence stays visible without holding up a certified target's release.
const CODEX_LEGS = [
  { platform_key: "linux-x64", runner: "ubuntu-latest", node_dist: "linux-x64", certified: true },
  { platform_key: "darwin-arm64", runner: "macos-latest", node_dist: "darwin-arm64", certified: true },
  { platform_key: "linux-arm64", runner: "ubuntu-24.04-arm", node_dist: "linux-arm64", certified: false },
  { platform_key: "darwin-x64", runner: "macos-15-intel", node_dist: "darwin-x64", certified: false },
  { platform_key: "win32-x64", runner: "windows-latest", node_dist: "win-x64", certified: true },
];

const OWN_DRIVERS = new Set(["claude-code", "codex"]);
const RUNNERS = {
  "linux-x64": { runner: "ubuntu-latest", node_dist: "linux-x64" },
  "linux-arm64": { runner: "ubuntu-24.04-arm", node_dist: "linux-arm64" },
  "darwin-x64": { runner: "macos-15-intel", node_dist: "darwin-x64" },
  "darwin-arm64": { runner: "macos-latest", node_dist: "darwin-arm64" },
  "win32-x64": { runner: "windows-latest", node_dist: "win-x64" },
};
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
 *           runtimeVersions?: string, harnesses?: string,
 *           record?: ReturnType<typeof readRuntimeCompat> }} input
 */
export function planConformance(input) {
  const record = input.record ?? readRuntimeCompat();
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
  const onlyLinux = (legs) => (pullRequest ? legs.filter((leg) => leg.platform_key === "linux-x64") : legs);
  const runtimes = packHarnesses.filter((id) => !OWN_DRIVERS.has(id));
  const named = parseRuntimeVersions(input.runtimeVersions, runtimes);
  const runtimeLegs = runtimes
    .filter((id) => selected.has(id) && (input.event !== "workflow_call" || named.has(id)))
    .flatMap((id) =>
      readAdvertisedTargets(id).map((target) => ({
        harness: id,
        platform_key: target,
        ...RUNNERS[target],
        pack_version: version(id, named.get(id)),
      })),
    );
  return {
    claude_pack_version: version("claude-code", input.claudeVersion),
    codex_pack_version: version("codex", input.codexVersion),
    run_claude: String(selected.has("claude-code")),
    run_codex: String(selected.has("codex")),
    run_windows: String(selected.has("claude-code") && !pullRequest),
    posix_matrix: JSON.stringify(onlyLinux(POSIX_LEGS)),
    codex_matrix: JSON.stringify(onlyLinux(CODEX_LEGS)),
    runtime_matrix: JSON.stringify(onlyLinux(runtimeLegs)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const plan = planConformance({
    event: process.env.EVENT ?? "",
    claudeVersion: process.env.CLAUDE_INPUT ?? "",
    codexVersion: process.env.CODEX_INPUT ?? "",
    runtimeVersions: process.env.RUNTIME_INPUT ?? "",
    harnesses: process.env.HARNESSES ?? "",
  });
  for (const [key, value] of Object.entries(plan)) process.stdout.write(`${key}=${value}\n`);
}
