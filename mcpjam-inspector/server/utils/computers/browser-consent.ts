/** Browser-only capability; never authorizes shell execution or harnesses. */
import { watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDeviceConsent } from "../device-consent.js";
export const BROWSER_CONSENT_HEADER = "x-mcpjam-browser-consent";
const consent = createDeviceConsent(() =>
  join(homedir(), ".mcpjam", "browser", "consent.json"),
);
export async function grantLocalBrowserConsent() {
  const grant = await consent.grant();
  const { invalidateBrowserConsentLifetimes } = await import(
    "../../services/browserd/local/consent-lifetime.js"
  );
  await invalidateBrowserConsentLifetimes(await consent.fingerprint());
  return grant;
}
export const verifyLocalBrowserConsent = consent.verify;
export const getBrowserConsentFingerprint = consent.fingerprint;
export const verifyAndFingerprintBrowserConsent = consent.verifyAndFingerprint;
export async function revokeLocalBrowserConsent(token?: string | null) {
  await consent.revoke(token);
  const { invalidateBrowserConsentLifetimes } = await import(
    "../../services/browserd/local/consent-lifetime.js"
  );
  await invalidateBrowserConsentLifetimes(await consent.fingerprint());
}

/** Watch the directory so atomic consent-file replacement is observed too. */
export function watchBrowserConsentChanges(changed: () => void): () => void {
  try {
    const watcher = watch(
      join(homedir(), ".mcpjam", "browser"),
      { persistent: false },
      changed,
    );
    watcher.on("error", () => watcher.close());
    return () => watcher.close();
  } catch {
    return () => {};
  } // The lifetime also polls if the directory is absent.
}
