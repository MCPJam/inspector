/**
 * sessionStorage-backed transcript for the tester (scenario) chat surface.
 *
 * The tester page mints a fresh `chatSessionId` and an empty transcript on
 * every mount, so a refresh — accidental or not — dropped the whole visible
 * conversation with no way back (BB-51). The owner's completed turns are
 * persisted server-side, but the tester reaches that thread through nothing:
 * the surface has no history rail, and a guest tester has no authorization to
 * read a project's chat history back.
 *
 * So the tester's own copy is kept here, next to the two things this surface
 * already stores per session: the redeemed grant
 * (`SCENARIO_SESSION_STORAGE_KEY`) and the enabled optional servers
 * (`scenarioEnabledOptionalStorageKey`). Same lifetime as both — a refresh
 * keeps it, closing the tab ends it — which is exactly the promise the
 * scenario grant makes, so resume never outlives the access it needs.
 *
 * The stored `chatSessionId` is as load-bearing as the messages: restoring it
 * keeps the tester appending to the SAME server-side thread, so an owner
 * reading Sessions sees one conversation instead of one fragment per refresh.
 */
import type { UIMessage } from "@ai-sdk/react";

/** Bump when the stored shape changes; an old row is then ignored, not misread. */
const STORAGE_KEY_PREFIX = "scenario-chat-transcript-v1:";

/**
 * Serialized-length ceiling for one stored transcript, in UTF-16 code units
 * (~2 MB of the ~5 MB sessionStorage origin budget).
 *
 * A transcript is not bounded by the text: an attached image rides along as a
 * `data:` URL, and two of those can outweigh a hundred turns. Rather than let
 * one attachment cost the tester the resume, `writeScenarioChatTranscript`
 * drops the OLDEST turns until the rest fits.
 */
const MAX_SERIALIZED_LENGTH = 1_000_000;

export interface ScenarioChatTranscript {
  chatSessionId: string;
  messages: UIMessage[];
}

export function scenarioChatTranscriptStorageKey(scenarioId: string): string {
  return `${STORAGE_KEY_PREFIX}${scenarioId}`;
}

/**
 * The stored transcript, or null when there is nothing usable to resume.
 *
 * A row that fails to parse or does not match the shape is REMOVED rather than
 * ignored in place: leaving it would keep failing on every mount for the rest
 * of the tab's life, and there is no version of this data worth recovering
 * partially — a transcript missing its `chatSessionId` would resume the
 * conversation onto a thread the next turn cannot append to.
 */
export function readScenarioChatTranscript(
  scenarioId: string
): ScenarioChatTranscript | null {
  const key = scenarioChatTranscriptStorageKey(scenarioId);
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      sessionStorage.removeItem(key);
      return null;
    }

    const { chatSessionId, messages } = parsed as {
      chatSessionId?: unknown;
      messages?: unknown;
    };
    if (
      typeof chatSessionId !== "string" ||
      !chatSessionId.trim() ||
      !Array.isArray(messages) ||
      messages.length === 0 ||
      !messages.every(
        (message) =>
          !!message && typeof message === "object" && "role" in message
      )
    ) {
      sessionStorage.removeItem(key);
      return null;
    }

    return {
      chatSessionId,
      messages: messages as UIMessage[],
    };
  } catch {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // sessionStorage unavailable (private-mode quirks); nothing to clean up.
    }
    return null;
  }
}

/**
 * Store what the tester can currently see, trimming from the oldest turn until
 * it fits the budget.
 *
 * An empty transcript CLEARS the row: the tester is looking at a blank chat, so
 * a stored one would resurrect a conversation they already left behind.
 *
 * A quota rejection (or a newest turn too large to store on its own) also
 * clears it, deliberately. Keeping the previous row would resume a transcript
 * that is missing its most recent turns while looking complete — worse than
 * starting clean, because the tester cannot tell that anything is absent.
 */
export function writeScenarioChatTranscript(
  scenarioId: string,
  transcript: ScenarioChatTranscript
): void {
  const key = scenarioChatTranscriptStorageKey(scenarioId);
  if (transcript.messages.length === 0) {
    clearScenarioChatTranscript(scenarioId);
    return;
  }

  try {
    let messages = transcript.messages;
    let serialized = JSON.stringify({
      chatSessionId: transcript.chatSessionId,
      messages,
    });
    while (serialized.length > MAX_SERIALIZED_LENGTH && messages.length > 1) {
      messages = messages.slice(1);
      serialized = JSON.stringify({
        chatSessionId: transcript.chatSessionId,
        messages,
      });
    }
    if (serialized.length > MAX_SERIALIZED_LENGTH) {
      clearScenarioChatTranscript(scenarioId);
      return;
    }
    sessionStorage.setItem(key, serialized);
  } catch {
    clearScenarioChatTranscript(scenarioId);
  }
}

export function clearScenarioChatTranscript(scenarioId: string): void {
  try {
    sessionStorage.removeItem(scenarioChatTranscriptStorageKey(scenarioId));
  } catch {
    // sessionStorage unavailable; there is nothing this caller can do.
  }
}
