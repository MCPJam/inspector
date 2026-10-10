/**
 * Session continuity for harness turns on an ORGANIZATION'S own provider key.
 *
 * A resumed harness session carries opaque provider state from the turns
 * before it (an encrypted reasoning item, a cached prompt prefix). That state
 * belongs to the provider ACCOUNT that produced it, so a session may resume
 * only on the same key: when the organization replaces its key, the next turn
 * starts a fresh runtime session instead of replaying old state into a
 * possibly different account. A rename, which changes nothing about the key,
 * resumes as before.
 *
 * The lease — and with it the credential revision the backend admitted — only
 * exists after the session lane is claimed, so the revision cannot be part of
 * the runtime fingerprint the claim compares. Instead an org turn STAMPS the
 * revision it ran on into the resume state it commits, and the next org turn
 * compares that stamp with its own lease's revision before it creates the
 * runtime session. Hosted turns never stamp, so their state is byte-identical
 * to before; the fingerprint's credential dimension keeps the two kinds of
 * lane apart.
 */
import type { HarnessUpstreamProfile } from "@/shared/harness-model-support";

const STAMP_KEY = "mcpjamOrgCredentialRevision";

type StampedResumeState = {
  [STAMP_KEY]: string;
  resumeState: unknown;
};

/** Wrap an org turn's committed resume state with its credential revision. */
export function stampOrgCredentialRevision(
  resumeState: unknown,
  credentialRevision: string,
): StampedResumeState {
  return { [STAMP_KEY]: credentialRevision, resumeState };
}

/**
 * The resume state as the adapter wrote it, and the revision it was stamped
 * with when an org turn committed it. Anything not in the stamped shape is
 * returned as-is with no revision (a hosted lane's state, or one committed
 * before org turns existed).
 */
export function unstampOrgCredentialRevision(resumeState: unknown): {
  resumeState: unknown;
  credentialRevision?: string;
} {
  if (
    resumeState !== null &&
    typeof resumeState === "object" &&
    !Array.isArray(resumeState)
  ) {
    const record = resumeState as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length === 2 &&
      typeof record[STAMP_KEY] === "string" &&
      "resumeState" in record
    ) {
      return {
        resumeState: record.resumeState,
        credentialRevision: record[STAMP_KEY] as string,
      };
    }
  }
  return { resumeState };
}

/**
 * Whether a lane's committed state may be resumed by an org turn holding a
 * lease on `credentialRevision`. Only a state stamped with the SAME revision:
 * an unstamped state was never produced on this key.
 */
export function orgResumeAllowed(
  stampedRevision: string | undefined,
  credentialRevision: string,
): boolean {
  return (
    stampedRevision !== undefined && stampedRevision === credentialRevision
  );
}

/** The upstream profile an org turn on `harnessId` runs under. */
export function orgUpstreamProfileFor(
  harnessId: string,
): Exclude<HarnessUpstreamProfile, "gateway"> | undefined {
  if (harnessId === "claude-code") return "anthropic-native";
  if (harnessId === "codex") return "openai-native";
  return undefined;
}
