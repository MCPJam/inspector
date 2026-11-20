/**
 * Home's first Playground prompt, sent on open. Kept until a Playground mount
 * tries to send it (one can unmount while loading) and ignored after a few
 * minutes.
 */
const KEY = "mcpjam.home-checklist.playground-autorun";
const MAX_AGE_MS = 5 * 60_000;

interface PendingAutorun {
  prompt: string;
  /** Checklist progress key to mark the chat step done once it's sent. */
  progressKey: string;
}

export function writeHomeChecklistAutorun(pending: PendingAutorun): void {
  try {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ ...pending, writtenAt: Date.now() }),
    );
  } catch {
    // Storage blocked: Playground opens with the usual empty composer.
  }
}

export function readHomeChecklistAutorun(): PendingAutorun | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingAutorun> & {
      writtenAt?: number;
    };
    const fresh =
      typeof parsed.writtenAt === "number" &&
      Date.now() - parsed.writtenAt < MAX_AGE_MS;
    return fresh &&
      typeof parsed.prompt === "string" &&
      typeof parsed.progressKey === "string"
      ? { prompt: parsed.prompt, progressKey: parsed.progressKey }
      : null;
  } catch {
    return null;
  }
}

export function clearHomeChecklistAutorun(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: nothing was stored.
  }
}
