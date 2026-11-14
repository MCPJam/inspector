// Every pack a build from this checkout may SELECT: the desired one per
// harness, and the one permitted previous. One version across targets; a
// record that permits two is refused here rather than half-tested.
//
//   node scripts/local-harness-release-packs.mjs >> "$GITHUB_OUTPUT"
//
// release.yml's preflight and the evidence run (local-harness-release-evidence.yml)
// both read the packs from here, so the conformance a release finds waiting
// for it was run against exactly the packs it would have run itself. `key`
// names that set of packs in the evidence marker.
import { pathToFileURL } from "node:url";
import { readRuntimeCompat } from "./local-harness-pack-tables.mjs";

export function releasePacks(record = readRuntimeCompat()) {
  const one = (harnessId, role) => {
    const versions = new Set(
      Object.values(record.harnesses[harnessId]?.targets ?? {})
        .map((slot) => slot[role]?.packVersion)
        .filter(Boolean),
    );
    if (versions.size > 1) throw new Error(`${harnessId} ${role} packs differ across targets: ${[...versions]}`);
    return [...versions][0] ?? "";
  };
  const packs = {
    claude_desired: one("claude-code", "desired"),
    codex_desired: one("codex", "desired"),
    claude_permitted: one("claude-code", "permitted"),
    codex_permitted: one("codex", "permitted"),
  };
  // Every other local runtime's packs, as the `<harnessId>=<version>` pairs
  // the conformance workflow's `runtime_pack_versions` takes.
  const runtimes = Object.keys(record.harnesses).filter((id) => id !== "claude-code" && id !== "codex").sort();
  const pairs = (role) => runtimes.filter((id) => one(id, role)).map((id) => `${id}=${one(id, role)}`);
  const runtimeDesired = pairs("desired").join(",");
  const runtimePermitted = pairs("permitted");
  const key = [packs.claude_desired, packs.codex_desired, packs.claude_permitted, packs.codex_permitted];
  // Only once such a runtime has a pack, so the key of today's packs is unchanged.
  if (runtimeDesired || runtimePermitted.length > 0) key.push(runtimeDesired, runtimePermitted.join(","));
  return {
    ...packs,
    runtime_desired: runtimeDesired,
    runtime_permitted: runtimePermitted.join(","),
    permitted_harnesses: [
      packs.claude_permitted && "claude-code",
      packs.codex_permitted && "codex",
      ...runtimePermitted.map((pair) => pair.split("=")[0]),
    ].filter(Boolean).join(","),
    key: key.join("/"),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  for (const [key, value] of Object.entries(releasePacks())) process.stdout.write(`${key}=${value}\n`);
}
