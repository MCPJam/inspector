/**
 * Credential values the MCPJam backend delivered to this process: OAuth access
 * tokens (a person's own sign-in, a project-shared or an uploaded account),
 * private-server refresh material, and the stored secret headers it revealed.
 *
 * The telemetry scrubber (`log-scrubber.ts`) works by key name and value
 * shape, so it catches `Bearer <token>` but not the same token standing alone
 * in an error message. These values are known exactly, so they are replaced
 * exactly, by the transcript scrubber's own matcher (`secret-scrubber.ts`).
 *
 * Bounded rather than cleared on disconnect: a token stays valid after its
 * connection closes and can still surface in a late error, so it stays
 * registered until newer values push it out. A value a live connection still
 * sends is never pushed out: a token that never expires is registered once,
 * and a long session's refreshes elsewhere would otherwise evict it. Empty,
 * and so free, in a browser.
 */
import { createSecretScrubber, type SecretScrubber } from "./secret-scrubber";

const MAX_REGISTERED = 256;

/** value → the name it is replaced by, oldest first. */
const registered = new Map<string, string>();
let scrubber: SecretScrubber | null | undefined;

/**
 * What each live holder sends now. A holder is an object that lives exactly as
 * long as its connection (its bound fetch), so a closed connection releases
 * its value without a disconnect hook.
 */
const holders = new WeakMap<object, { value: string }>();
const holderRefs = new Set<WeakRef<object>>();

function heldValues(): Set<string> {
  const values = new Set<string>();
  for (const ref of holderRefs) {
    const holder = ref.deref();
    const slot = holder && holders.get(holder);
    if (slot) values.add(slot.value);
    else holderRefs.delete(ref);
  }
  return values;
}

export function registerDeliveredSecret(
  value: string | null | undefined,
  name: string,
  holder?: object,
): void {
  if (!value) return;
  if (holder) {
    const slot = holders.get(holder);
    if (slot) slot.value = value;
    else {
      holders.set(holder, { value });
      holderRefs.add(new WeakRef(holder));
    }
  }
  registered.delete(value);
  registered.set(value, name);
  if (registered.size > MAX_REGISTERED) {
    const held = heldValues();
    for (const oldest of registered.keys()) {
      if (registered.size <= MAX_REGISTERED) break;
      if (!held.has(oldest)) registered.delete(oldest);
    }
  }
  scrubber = undefined;
}

function currentScrubber(): SecretScrubber | null {
  if (scrubber === undefined) {
    scrubber = createSecretScrubber(
      [...registered].map(([value, name]) => ({ name, value })),
      // The log scrubber's own spelling: `[secret:…]` reads as a key=value
      // pair to its shape patterns, which would mangle it.
      { replacement: (name) => `[redacted-${name}]` },
    );
  }
  return scrubber;
}

export function hasDeliveredSecrets(): boolean {
  return currentScrubber() !== null;
}

/** `text` with every registered value replaced by `[redacted-NAME]`. */
export function scrubDeliveredSecrets(text: string): string {
  return currentScrubber()?.scrubString(text) ?? text;
}

/** The same, over the string leaves (and keys) of a plain JSON-ish value. */
export function scrubDeliveredSecretsDeep<T>(value: T): T {
  const active = currentScrubber();
  return active ? active.scrubDeep(value) : value;
}
