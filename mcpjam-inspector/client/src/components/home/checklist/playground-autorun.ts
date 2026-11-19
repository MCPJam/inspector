/**
 * Hands the Home checklist's first Playground prompt to Playground, which
 * sends it on open. sessionStorage so a stale prompt can't follow the user
 * into another browser session; read once, then cleared.
 */
const KEY = "mcpjam.home-checklist.playground-autorun";

interface PendingAutorun {
  prompt: string;
  /** Checklist progress key to mark the chat step done once it's sent. */
  progressKey: string;
}

export function writeHomeChecklistAutorun(pending: PendingAutorun): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Storage blocked: Playground opens with the usual empty composer.
  }
}

export function consumeHomeChecklistAutorun(): PendingAutorun | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as Partial<PendingAutorun>;
    return typeof parsed.prompt === "string" &&
      typeof parsed.progressKey === "string"
      ? { prompt: parsed.prompt, progressKey: parsed.progressKey }
      : null;
  } catch {
    return null;
  }
}
