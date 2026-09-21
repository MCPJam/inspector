/** Revocable authorization for local browser resources, including idle viewers. */
import {
  getBrowserConsentFingerprint,
  watchBrowserConsentChanges,
} from "../../../utils/computers/browser-consent.js";
import { BrowserPolicyError } from "./security-policy.js";

type Teardown = () => void | Promise<void>;
export async function createBrowserConsentLifetime(
  expected?: string,
  read: () => Promise<string | null> = getBrowserConsentFingerprint,
  admission?: () => Promise<boolean>,
) {
  const fingerprint = expected ?? (await read());
  let valid = Boolean(fingerprint);
  const callbacks = new Set<Teardown>();
  let disposal: Promise<void> | undefined;
  let checking: Promise<void> | undefined;
  let stopWatching: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const revoke = () => {
    if (disposal) return disposal;
    valid = false;
    clearInterval(timer);
    stopWatching?.();
    const current = [...callbacks];
    callbacks.clear();
    disposal = Promise.allSettled(
      current.map((callback) => Promise.resolve().then(callback)),
    ).then(() => {});
    return disposal;
  };
  const assertActive = async () => {
    if (
      !valid ||
      !fingerprint ||
      (await read().catch(() => null)) !== fingerprint ||
      (admission && !(await admission().catch(() => false)))
    ) {
      void revoke();
      throw new BrowserPolicyError(
        "Browser permission was revoked or changed. Allow Browser again to start a new session.",
      );
    }
  };
  await assertActive();
  const check = () => {
    if (checking) return;
    checking = assertActive()
      .catch(() => {})
      .finally(() => {
        checking = undefined;
      });
  };
  timer = setInterval(check, 1000);
  if (read === getBrowserConsentFingerprint)
    stopWatching = watchBrowserConsentChanges(check);
  timer.unref?.();
  const lifetime = {
    fingerprint: fingerprint!,
    assertActive,
    isActive: () => valid,
    onRevoked(callback: Teardown) {
      if (!valid) {
        void Promise.resolve().then(callback);
        return () => {};
      }
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    revoke,
    dispose() {
      valid = false;
      clearInterval(timer);
      stopWatching?.();
      callbacks.clear();
      activeLifetimes.delete(lifetime);
    },
  };
  activeLifetimes.add(lifetime);
  return lifetime;
}
const activeLifetimes = new Set<
  Awaited<ReturnType<typeof createBrowserConsentLifetime>>
>();
export async function invalidateBrowserConsentLifetimes(
  current: string | null,
): Promise<void> {
  await Promise.allSettled(
    [...activeLifetimes]
      .filter((lifetime) => lifetime.fingerprint !== current)
      .map(async (lifetime) => {
        await lifetime.revoke();
        lifetime.dispose();
      }),
  );
}
