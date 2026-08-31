/**
 * The score page's own resume record.
 *
 * The hosted-OAuth pending marker restores the SERVER's authorization state —
 * it knows nothing about a run being in flight. So when a visitor is bounced
 * to an authorization server and comes back, the marker is enough to finish
 * the connection and nothing more: the score run they started would simply be
 * gone, and they would face an empty form again with no idea what happened.
 *
 * This record is the missing half: what they were scoring and that they meant
 * to score it. sessionStorage, not localStorage — a run intent belongs to the
 * tab that started it, and should not resurrect in a window opened tomorrow.
 */

const STORAGE_KEY = "mcpjam-score-run-resume";
/** Long enough for a real authorization detour, short enough not to haunt. */
const TTL_MS = 15 * 60_000;

export interface ScoreRunResumeRecord {
  serverUrl: string;
  serverName: string;
  deliveryEmail?: string;
  startedAt: number;
}

export function writeScoreRunResume(
  record: Omit<ScoreRunResumeRecord, "startedAt">,
): void {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...record, startedAt: Date.now() }),
    );
  } catch {
    // Storage unavailable (private mode, quota). The run is simply not
    // resumable — the form still works.
  }
}

export function readScoreRunResume(): ScoreRunResumeRecord | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ScoreRunResumeRecord> | null;
    if (
      !parsed ||
      typeof parsed.serverUrl !== "string" ||
      typeof parsed.serverName !== "string" ||
      typeof parsed.startedAt !== "number"
    ) {
      clearScoreRunResume();
      return null;
    }
    if (Date.now() - parsed.startedAt > TTL_MS) {
      clearScoreRunResume();
      return null;
    }
    return {
      serverUrl: parsed.serverUrl,
      serverName: parsed.serverName,
      ...(typeof parsed.deliveryEmail === "string"
        ? { deliveryEmail: parsed.deliveryEmail }
        : {}),
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

export function clearScoreRunResume(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}
