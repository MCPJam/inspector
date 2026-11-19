/**
 * Hands the Home checklist's first Playground prompt to Playground, which
 * sends it on open. sessionStorage so a stale prompt can't follow the user
 * into another browser session. Claimed into memory on first read so a
 * Playground that remounts before sending still gets it; cleared once sent.
 */
const KEY = "mcpjam.home-checklist.playground-autorun";

interface PendingAutorun {
  prompt: string;
  /** Checklist progress key to mark the chat step done once it's sent. */
  progressKey: string;
}

let claimed: PendingAutorun | null = null;

export function writeHomeChecklistAutorun(pending: PendingAutorun): void {
  claimed = null;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Storage blocked: Playground opens with the usual empty composer.
  }
}

export function consumeHomeChecklistAutorun(): PendingAutorun | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return claimed;
    window.sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as Partial<PendingAutorun>;
    claimed =
      typeof parsed.prompt === "string" &&
      typeof parsed.progressKey === "string"
        ? { prompt: parsed.prompt, progressKey: parsed.progressKey }
        : null;
  } catch {
    claimed = null;
  }
  return claimed;
}

export function clearHomeChecklistAutorun(): void {
  claimed = null;
}
