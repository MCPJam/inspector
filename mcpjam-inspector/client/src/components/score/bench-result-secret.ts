/**
 * The one-time result secret, kept for as long as the run it opens.
 *
 * `POST /runs` is the ONLY response that carries `resultSecret`. The backend
 * stores a digest, so the plaintext exists in that one response and nowhere
 * else; `GET /runs/:id` cannot hand it back, by design. Anything that replaces
 * the run row with a poll response therefore destroys the only capability that
 * can load the report the visitor just paid for — silently, and with no way to
 * recover it on a refresh.
 *
 * So it is held here, keyed by run id, rather than read off whatever the last
 * response happened to be.
 *
 * sessionStorage for the same reason `score-run-resume` uses it: this is a
 * capability, and a capability should not outlive the tab that was granted it
 * or resurface in a window opened tomorrow. It does survive the two things
 * that matter — a refresh, and the round trip through an authorization server.
 */

const STORAGE_KEY = "mcpjam-bench-result-secrets";
/** Comfortably longer than the 45-minute hosted wall clock. */
const TTL_MS = 90 * 60_000;
/** A visitor scoring all evening should not grow this without bound. */
const MAX_ENTRIES = 20;

type Entry = { secret: string; at: number };
type Store = Record<string, Entry>;

function readStore(): Store {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const now = Date.now();
    const out: Store = {};
    for (const [runId, value] of Object.entries(parsed as Store)) {
      if (
        value &&
        typeof value.secret === "string" &&
        typeof value.at === "number" &&
        now - value.at <= TTL_MS
      ) {
        out[runId] = value;
      }
    }
    return out;
  } catch {
    // Private mode, quota, corrupt JSON. The run is simply not resumable from
    // this tab; every other path still works.
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore storage failures — see readStore.
  }
}

export function rememberBenchResultSecret(runId: string, secret: string): void {
  const store = readStore();
  store[runId] = { secret, at: Date.now() };
  const entries = Object.entries(store);
  if (entries.length > MAX_ENTRIES) {
    // Oldest first, so the run being watched right now is never the one evicted.
    entries.sort((a, b) => a[1].at - b[1].at);
    for (const [runId] of entries.slice(0, entries.length - MAX_ENTRIES)) {
      delete store[runId];
    }
  }
  writeStore(store);
}

export function readBenchResultSecret(runId: string): string | null {
  return readStore()[runId]?.secret ?? null;
}

export function forgetBenchResultSecret(runId: string): void {
  const store = readStore();
  if (!(runId in store)) return;
  delete store[runId];
  writeStore(store);
}
