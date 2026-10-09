/**
 * What a harness's runtime pack release and its assets are called.
 *
 * The TypeScript twin of `packReleaseTag` / `packAssetStem` in
 * `scripts/local-harness-pack-harnesses.mjs` — duplicated because that script
 * runs under a bare Node with no TypeScript in the loop, and pinned to it by
 * `pack-naming.test.ts`, because an installer that guesses a name the build
 * never wrote downloads nothing.
 *
 * Claude Code keeps the names its first pack shipped under
 * (`local-harness-pack-v<ver>`, `local-harness-pack-<target>-<ver>.*`), so an
 * Inspector already pinned to them keeps finding them. Every other harness
 * carries its id in both, so two harnesses can never collide on a version.
 */
import type { LocalPackTarget, SupportedLocalHarnessId } from "./targets.js";

const LEGACY_NAMED_HARNESS: SupportedLocalHarnessId = "claude-code";

/** A pack release's git tag. */
export function packReleaseTag(
  harnessId: SupportedLocalHarnessId,
  packVersion: string,
): string {
  return harnessId === LEGACY_NAMED_HARNESS
    ? `local-harness-pack-v${packVersion}`
    : `local-harness-pack-${harnessId}-v${packVersion}`;
}

/** The stem every asset of one target's pack shares. */
export function packAssetStem(
  harnessId: SupportedLocalHarnessId,
  target: LocalPackTarget | string,
  packVersion: string,
): string {
  return harnessId === LEGACY_NAMED_HARNESS
    ? `local-harness-pack-${target}-${packVersion}`
    : `local-harness-pack-${harnessId}-${target}-${packVersion}`;
}

/** The release download base for a harness's pack version, with a trailing slash. */
export function packReleaseBaseUrl(
  harnessId: SupportedLocalHarnessId,
  packVersion: string,
): string {
  return (
    "https://github.com/MCPJam/inspector/releases/download/" +
    `${packReleaseTag(harnessId, packVersion)}/`
  );
}
