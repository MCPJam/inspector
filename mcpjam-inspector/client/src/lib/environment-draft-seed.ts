/**
 * One-shot handoff of a pre-seeded environment draft from Connect's
 * "Save as environment" to the `/environments` create form.
 *
 * Structural sibling of `previewed-environment-storage.ts` (key + typed record
 * + try/catch swallow), with two deliberate differences:
 *
 * - `sessionStorage`, not `localStorage`: the seed must survive the
 *   `/environments` route's flag-hydration null-render (the route returns
 *   `null` until `project-environments-enabled` settles, so any in-memory
 *   handoff would be lost to remounts) but die with the tab — a day-old seed
 *   silently reopening create mode would be a bug, not a feature.
 * - `take` is read+DELETE: consuming the seed is what prevents a later manual
 *   visit to `/environments` from re-entering create mode. No event
 *   subscription — the handoff is same-tab and single-hop.
 *
 * Both entry points NORMALIZE the project key (trim) rather than trusting the
 * caller: Connect reads a normalized id while the `/environments` route holds
 * the raw active-project id, so a whitespace-padded id would otherwise be
 * written under one key and looked up under another — silently dropping the
 * handoff. Keeping the trim here (not at each call site) makes that mismatch
 * structurally impossible.
 *
 * The literal `null`s on `serverAttachmentId`/`skillSelection` document the v1
 * capture decision: Connect has no server-group or enabled-skills state to
 * capture, and `serverAttachmentId: null` already MEANS "the client's own
 * server picks apply" — which is exactly what Connect is running.
 */

const STORAGE_KEY = "mcp-environment-draft-seed";

export interface EnvironmentDraftSeed {
  name?: string;
  hostId: string | null;
  serverAttachmentId: null;
  skillSelection: null;
}

export function saveEnvironmentDraftSeed(
  projectId: string,
  seed: EnvironmentDraftSeed
): void {
  const key = projectId.trim();
  if (!key) return;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const all = raw
      ? (JSON.parse(raw) as Record<string, EnvironmentDraftSeed>)
      : {};
    all[key] = seed;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable ⇒ the CTA degrades to plain navigation.
  }
}

/** Read AND delete the seed for this project (one-shot). */
export function takeEnvironmentDraftSeed(
  projectId: string
): EnvironmentDraftSeed | null {
  const key = projectId.trim();
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, EnvironmentDraftSeed>;
    const seed = all[key];
    if (!seed || typeof seed !== "object") return null;
    delete all[key];
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    return {
      ...(typeof seed.name === "string" ? { name: seed.name } : {}),
      hostId: typeof seed.hostId === "string" ? seed.hostId : null,
      serverAttachmentId: null,
      skillSelection: null,
    };
  } catch {
    return null;
  }
}
