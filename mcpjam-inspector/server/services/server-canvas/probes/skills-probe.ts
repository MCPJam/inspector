/**
 * The `skills` probe. The listing comes from the connect capture, which lists
 * skills without reading any. Verification happens here, for a sample, under
 * the same rules as the Apps probe's `ui://` reads (`input-guard.ts`): hosted
 * under the input guard, not at all on a local 2025-era connection, and on
 * 2026-07-28 straight on the connection's client, so a server that asks for
 * input is abandoned and never reaches the user.
 *
 * Each sampled skill gets one `skills/get`, then its SKILL.md is read and
 * checked against the manifest by `getVerifiedServerSkill`. Skills are checked
 * one at a time; a request for input, or the budget, ends the sample. A read
 * that times out or loses its connection counts as unchecked, never as a
 * failure.
 */
import {
  DOCTOR_SKILL_VERIFY_SAMPLE,
  getVerifiedServerSkill,
  isServerSkillRefusalError,
  type ConnectedServerDoctorState,
  type MCPClientManager,
  type ProbeSummary,
} from "@mcpjam/sdk";
import {
  askedForInput,
  readOnConnection,
  serverAnswered,
} from "./connection-reads.js";
import type { ProbeInputGuard } from "./input-guard.js";
import { isRecord, probeSummary, unranProbe } from "./shared.js";

export const SKILL_READ_TIMEOUT_MS = 2_500;

export const LOCAL_LEGACY_SKILL_READS_SKIPPED =
  "MCPJam does not read skill files in the background on this connection, since the server could ask you for input. Run checks to read them.";
const SKILLS_INACTIVE = "The Skills extension is not active on this connection.";
const SKILLS_UNANSWERED = "skills/list did not answer.";
const NOT_LISTED = "The connect capture did not list skills, so they were not checked.";

/** Refusal kinds that mean a file's bytes disagree with its manifest. */
const DIGEST_REFUSALS: readonly string[] = ["digest_mismatch", "size_mismatch"];
/** Refusal kinds that mean SKILL.md frontmatter disagrees with the listing. */
const FRONTMATTER_REFUSALS: readonly string[] = [
  "frontmatter_drift",
  "identity_mismatch",
];

type Verification =
  | "verified"
  | "digest"
  | "frontmatter"
  /** The server answered, but the skill could not be loaded for another reason. */
  | "unreadable"
  | "input"
  | "unanswered"
  | "stopped";

/** A read that ended without an answer from the server. */
class SkillReadEnded extends Error {
  constructor(readonly kind: "input" | "unanswered" | "stopped") {
    super(`Skill read ended: ${kind}`);
    this.name = "SkillReadEnded";
  }
}

export interface SkillsProbeInput {
  manager: MCPClientManager;
  managerKey: string;
  doctor: ConnectedServerDoctorState | undefined;
  guard: ProbeInputGuard;
  signal: AbortSignal;
  now: () => number;
}

/** The loadable skills the doctor's listing named, up to the sample size. */
export function skillsToVerify(doctor: ConnectedServerDoctorState): string[] {
  const uris: string[] = [];
  for (const skill of doctor.skills) {
    if (!isRecord(skill) || skill.unloadable || typeof skill.skillUri !== "string") {
      continue;
    }
    uris.push(skill.skillUri);
    if (uris.length === DOCTOR_SKILL_VERIFY_SAMPLE) break;
  }
  return uris;
}

function classify(error: unknown, signal: AbortSignal): Verification {
  if (error instanceof SkillReadEnded) return error.kind;
  if (isServerSkillRefusalError(error)) {
    const { kind } = error.refusal;
    if (DIGEST_REFUSALS.includes(kind)) return "digest";
    if (FRONTMATTER_REFUSALS.includes(kind)) return "frontmatter";
    return "unreadable";
  }
  if (askedForInput(error)) return "input";
  if (signal.aborted) return "stopped";
  return serverAnswered(error) ? "unreadable" : "unanswered";
}

async function verifyOne(input: SkillsProbeInput, uri: string): Promise<Verification> {
  const { manager, managerKey, signal } = input;
  const end = input.guard.track();
  let outcome: Verification;
  try {
    const { skill } = await manager.getServerSkillResult(managerKey, uri, {
      signal,
      timeout: SKILL_READ_TIMEOUT_MS,
    });
    await getVerifiedServerSkill(manager, {
      serverId: managerKey,
      uri,
      entry: skill,
      read: async (fileUri) => {
        const read = await readOnConnection(manager, managerKey, fileUri, {
          signal,
          timeoutMs: SKILL_READ_TIMEOUT_MS,
        });
        if (read.kind === "read") return read.result;
        if (read.kind === "error") throw read.error;
        throw new SkillReadEnded(read.kind);
      },
    });
    outcome = "verified";
  } catch (error) {
    outcome = classify(error, signal);
  }
  // The server asked for input while this skill was being read.
  return end() ? "input" : outcome;
}

export async function runSkillsProbe(
  input: SkillsProbeInput,
): Promise<ProbeSummary<"skills">> {
  const { doctor } = input;
  if (!doctor) return unranProbe("skills", "failed", input.now(), NOT_LISTED);
  const check = doctor.checks.skills;
  if (check.status === "skipped") {
    return unranProbe("skills", "not-applicable", input.now(), SKILLS_INACTIVE);
  }
  // An error without findings is the listing itself failing.
  if (check.status === "error" && !check.findings) {
    return probeSummary("skills", {
      status: "failed",
      coverage: "not-captured",
      at: input.now(),
      detail: SKILLS_UNANSWERED,
      values: { listed: false },
    });
  }
  const count = doctor.skills.length;
  const uris = skillsToVerify(doctor);
  if (uris.length > 0 && !input.guard.readsAllowed) {
    return probeSummary("skills", {
      status: "ok",
      coverage: "partial",
      at: input.now(),
      detail: LOCAL_LEGACY_SKILL_READS_SKIPPED,
      values: { listed: true, count },
    });
  }

  const tally: Record<Verification, number> = {
    verified: 0,
    digest: 0,
    frontmatter: 0,
    unreadable: 0,
    input: 0,
    unanswered: 0,
    stopped: 0,
  };
  let checked = 0;
  for (const uri of uris) {
    const outcome = await verifyOne(input, uri);
    tally[outcome] += 1;
    checked += 1;
    if (outcome === "input" || outcome === "stopped") break;
  }
  const finished =
    checked === uris.length &&
    tally.input === 0 &&
    tally.unanswered === 0 &&
    tally.stopped === 0;
  return probeSummary("skills", {
    status: "ok",
    coverage: finished ? "complete" : "partial",
    at: input.now(),
    ...(tally.input > 0
      ? { detail: "A skill asked for input, so reading stopped there." }
      : finished
        ? {}
        : { detail: "A skill file read got no answer in time." }),
    values: {
      listed: true,
      count,
      verified: tally.verified,
      digestFailures: tally.digest,
      frontmatterFailures: tally.frontmatter,
    },
  });
}
