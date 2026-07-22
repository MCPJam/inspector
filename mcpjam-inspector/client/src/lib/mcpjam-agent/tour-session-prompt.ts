/**
 * Durable per-session system prompts for Learning-tab guided tours.
 *
 * When `launchLessonSession` mints a tour session, the tour's instructions
 * (walk + ground rules) ride in the request `systemPrompt` rather than the
 * visible first user message. The agent transport's `body()` re-reads this
 * registry on EVERY POST of the session, so the tour context survives later
 * turns, reloads, and Recent Chats resume — which is why this is localStorage,
 * unlike the one-shot sessionStorage handoff in `pending-prompt.ts`.
 *
 * Entries are an MRU stack capped at `MAX_ENTRIES` (matching
 * `recent-sessions.ts`): a tour session evicted `MAX_ENTRIES` launches later
 * simply degrades to a normal agent chat, the same lifetime as its Recent
 * Chats pill. Storage failures are swallowed everywhere — the tour still runs,
 * it just loses tour-awareness after a reload.
 */

const STORAGE_KEY = "mcpjam:agent-tour-system-prompts:v1";
const MAX_ENTRIES = 12;

interface TourSystemPromptEntry {
  sessionId: string;
  tourId: string;
  systemPrompt: string;
  /** Unix ms of the launch, for debuggability; ordering is array position. */
  ts: number;
}

function safeParse(raw: string | null): TourSystemPromptEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is TourSystemPromptEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as TourSystemPromptEntry).sessionId === "string" &&
        typeof (entry as TourSystemPromptEntry).tourId === "string" &&
        typeof (entry as TourSystemPromptEntry).systemPrompt === "string" &&
        typeof (entry as TourSystemPromptEntry).ts === "number",
    );
  } catch {
    return [];
  }
}

function load(): TourSystemPromptEntry[] {
  if (typeof window === "undefined") return [];
  try {
    return safeParse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

export function writeTourSystemPrompt(
  sessionId: string,
  { tourId, systemPrompt }: { tourId: string; systemPrompt: string },
): void {
  if (typeof window === "undefined") return;
  try {
    const next: TourSystemPromptEntry[] = [
      { sessionId, tourId, systemPrompt, ts: Date.now() },
      ...load().filter((entry) => entry.sessionId !== sessionId),
    ].slice(0, MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota/disabled storage — the launch proceeds; the session just isn't
    // tour-aware on the server side. See doc comment above.
  }
}

/**
 * The system prompt for a tour session, or null for any non-tour session.
 * Called from the agent transport's `body()` on every POST.
 *
 * Reading promotes the entry to the front so an actively posting session
 * can't be evicted by `MAX_ENTRIES` newer launches (true MRU, not FIFO).
 * Guarded so the common case — already at the front — costs no write.
 */
export function readTourSystemPrompt(sessionId: string): string | null {
  const entries = load();
  const index = entries.findIndex((e) => e.sessionId === sessionId);
  if (index < 0) return null;
  const entry = entries[index];
  if (index > 0 && typeof window !== "undefined") {
    try {
      entries.splice(index, 1);
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([entry, ...entries]),
      );
    } catch {
      // Promotion is best-effort; returning the prompt is still correct.
    }
  }
  return entry.systemPrompt;
}

/** Test-only: clears the registry between cases. */
export function __resetTourSystemPromptsForTests(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
