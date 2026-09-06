/**
 * run-pinned-harness-skills.ts — a run's frozen skills, in the shape the
 * HARNESS delivers.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * A harness turn materializes skills ON THE BOX, as SKILL.md files under the
 * runtime's skills root. It picks its source through `selectHarnessSkillSource`,
 * which is a strict precedence:
 *
 *   pinned  →  environment  →  live
 *
 * and the top of that list is the only one a frozen run may use. `pinned` is
 * selected by PRESENCE, not length: passing `[]` means "this run delivers no
 * skills", while passing nothing at all falls through to the live project-wide
 * fetch — the whole current project pool, resolved at turn time.
 *
 * That fall-through is the failure this module removes. An eval run pins its
 * skills at run start precisely so a re-run is byte-identical; a harness turn
 * that re-fetched the live pool would see whatever the project happens to hold
 * NOW, so editing a project skill mid-run would change what a running iteration
 * sees. The `skillsOverride: "exclude"` A/B arm has the same problem in a
 * sharper form: its whole point is to be deliberately skill-free, and a live
 * fetch would hand it every skill in the project.
 *
 * So: every runId-bearing eval run passes an explicit artifact list, empty
 * included.
 *
 * ── Why the files are downloaded here ──────────────────────────────────────
 * `getRunPinnedSkills` serves supporting files as SIGNED, SHORT-LIVED URLs;
 * `PinnedSkillArtifact` carries file bodies INLINE, because the harness writes
 * them onto the box directly rather than fetching from it. Something has to
 * bridge the two, and this is the right place: it runs once per run during
 * preparation — before any model call — where a fetch failure can fail the run
 * cleanly and name the skill and path, exactly as `assertPinnedSkillFilesReachable`
 * does for an unreachable blob. Doing it per iteration would re-download the
 * same bytes N times and turn a transient blob-store blip into a mid-run
 * failure.
 *
 * A skill delivered WITHOUT its scripts is the silent-degradation shape this
 * whole program exists to remove: the run reports the skill as delivered and
 * the judge scores against a surface that was never there. So a download
 * failure throws `RunPluginSnapshotError` rather than dropping the file.
 */
import type { PinnedSkillArtifact } from "../../../shared/skill-types.js";
import { logger } from "../../utils/logger.js";
import {
  RunPluginSnapshotError,
  type RunPinnedSkill,
} from "./run-plugin-snapshot.js";

/** Per-file download budget. Pinned supporting files are small by construction
 *  (the pin store rejects large blobs), so a slow one is a broken one. */
const FILE_FETCH_TIMEOUT_MS = 15_000;

/**
 * Text-ish media types get an inline `content` string; everything else rides
 * base64. The harness's file writer branches on exactly this: `content` goes
 * through `writeTextFile`, `base64` through `base64 -d`. Guessing wrong on a
 * binary is not cosmetic — a lossy UTF-8 decode would corrupt the file on box.
 * When the server says nothing, base64 is the safe answer.
 */
function isTextualMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  if (type.startsWith("text/")) return true;
  return [
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-sh",
    "application/x-shellscript",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
  ].includes(type);
}

async function downloadPinnedFile(
  pin: RunPinnedSkill,
  file: NonNullable<RunPinnedSkill["files"]>[number],
  signal?: AbortSignal
): Promise<
  PinnedSkillArtifact["files"] extends (infer F)[] | undefined ? F : never
> {
  const ref = pin.modelRef ?? pin.name;
  // Callers run `assertPinnedSkillFilesReachable` first, so this is a
  // belt-and-braces narrowing rather than the primary check.
  if (typeof file.url !== "string" || file.url.length === 0) {
    throw new RunPluginSnapshotError(
      ref,
      `This run pinned the skill "${ref}", but its supporting file "${file.path}" has no readable blob URL. The run was stopped rather than executed with the file missing.`
    );
  }

  let response: Response;
  try {
    response = await fetch(file.url, {
      signal: signal ?? AbortSignal.timeout(FILE_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RunPluginSnapshotError(
      ref,
      `This run pinned the skill "${ref}", but its supporting file "${
        file.path
      }" could not be downloaded from the run snapshot (${
        error instanceof Error ? error.message : String(error)
      }). The run was stopped rather than executed with the file missing.`
    );
  }
  if (!response.ok) {
    throw new RunPluginSnapshotError(
      ref,
      `This run pinned the skill "${ref}", but its supporting file "${file.path}" could not be downloaded from the run snapshot (HTTP ${response.status}). The run was stopped rather than executed with the file missing.`
    );
  }

  // `content-type` from the blob store is the only signal about text vs binary
  // — the pin row records a path and a size, not a media type.
  const mimeType = response.headers.get("content-type") ?? undefined;
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    path: file.path,
    ...(mimeType ? { mimeType } : {}),
    ...(isTextualMimeType(mimeType)
      ? { content: buffer.toString("utf8") }
      : { base64: buffer.toString("base64") }),
  } as never;
}

/**
 * Project a run's pinned skills onto the harness's artifact shape, downloading
 * every supporting file's body.
 *
 * Field mapping is a straight carry-over — nothing is synthesized. In
 * particular `contentHash` takes the pin's `aggregateHash` WHEN PRESENT: the
 * artifact's `contentHash` is documented as the complete-envelope fingerprint,
 * and it is what `pinnedArtifactsToRuntimeSkills` turns into the runtime
 * `aggregateHash` that drives on-box reconcile and the turn's `skillsHash`. A
 * body-only hash there would make two runs of a skill whose FILES changed look
 * identical to the reconcile pass, so a reused box would keep the previous
 * run's scripts.
 */
export async function runPinnedSkillsToHarnessArtifacts(
  pins: readonly RunPinnedSkill[],
  opts: { signal?: AbortSignal } = {}
): Promise<PinnedSkillArtifact[]> {
  const artifacts: PinnedSkillArtifact[] = [];
  for (const pin of pins) {
    const files: NonNullable<PinnedSkillArtifact["files"]> = [];
    for (const file of pin.files ?? []) {
      files.push(await downloadPinnedFile(pin, file, opts.signal));
    }
    artifacts.push({
      name: pin.name,
      description: pin.description,
      content: pin.content,
      // Complete-envelope identity; the pin carries the body-only hash when it
      // has no files, in which case the two are equal by definition.
      contentHash: pin.aggregateHash ?? pin.contentHash,
      ...(pin.skillId ? { skillId: pin.skillId } : {}),
      ...(pin.sharing ? { sharing: pin.sharing } : {}),
      // `channels` on a pin includes "mcp-server", which the artifact's own
      // union does not carry. Filter rather than widen: nothing in the harness
      // branches on the value (it is a presence check), and a captured
      // server skill is not one of the three composition channels.
      ...(pin.channels
        ? {
            channels: pin.channels.filter(
              (c): c is "host" | "environment" | "plugin" =>
                c === "host" || c === "environment" || c === "plugin"
            ),
          }
        : {}),
      ...(pin.extraFrontmatter ? { frontmatter: pin.extraFrontmatter } : {}),
      ...(files.length > 0 ? { files } : {}),
    });
  }
  if (artifacts.length > 0) {
    logger.debug("[evals] adapted run pinned skills for the harness", {
      skills: artifacts.length,
      files: artifacts.reduce((n, a) => n + (a.files?.length ?? 0), 0),
    });
  }
  return artifacts;
}
