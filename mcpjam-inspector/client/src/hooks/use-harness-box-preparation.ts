import { useEffect, useRef } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { authFetch } from "@/lib/session-token";

/** A new hosted harness chat, and the body its preparation resolves from. */
export interface HarnessBoxPreparationRequest {
  chatSessionId: string;
  body: Record<string, unknown>;
}

const PREPARE_PATH = "/api/web/chat/prepare";
/** The backend checks the same flag before it boots anything. */
const PREPARATION_FLAG = "harness-box-preparation-enabled";
const DEBOUNCE_MS = 500;
/** Chats already asked for, across remounts: at most one request per chat. */
const requestedChats = new Set<string>();

/**
 * Ask the server to set up a new chat's computer while its first message is
 * typed: 500 ms after the composer first holds text, once per chat, while the
 * member's `harness-box-preparation-enabled` flag is on. Nothing is shown,
 * and a failure only means the Send sets the computer up itself.
 */
export function useHarnessBoxPreparation(
  request: HarnessBoxPreparationRequest | null,
  input: string,
): void {
  const enabled = useFeatureFlagEnabled(PREPARATION_FLAG) === true;
  const latest = useRef(request);
  latest.current = request;
  const chatSessionId = request?.chatSessionId;
  const hasText = input.trim().length > 0;
  useEffect(() => {
    if (
      !enabled ||
      !chatSessionId ||
      !hasText ||
      requestedChats.has(chatSessionId)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      const current = latest.current;
      if (current?.chatSessionId !== chatSessionId) return;
      if (requestedChats.has(chatSessionId)) return;
      requestedChats.add(chatSessionId);
      authFetch(PREPARE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(current.body),
      }).catch((error: unknown) => {
        // The Send never depends on it; there is nothing to tell the person.
        // Only the error's class: a network error can name the request.
        console.debug(
          "[harness-prepare] request failed",
          error instanceof Error ? error.name : typeof error,
        );
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, chatSessionId, hasText]);
}
