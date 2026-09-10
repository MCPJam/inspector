/** Browser-only capability; never authorizes shell execution or harnesses. */
import { homedir } from "node:os";
import { join } from "node:path";
import { createDeviceConsent } from "../device-consent.js";
export const BROWSER_CONSENT_HEADER = "x-mcpjam-browser-consent";
const consent = createDeviceConsent(() =>
  join(homedir(), ".mcpjam", "browser", "consent.json"),
);
export const grantLocalBrowserConsent = consent.grant;
export const verifyLocalBrowserConsent = consent.verify;
export const getBrowserConsentFingerprint = consent.fingerprint;
export const verifyAndFingerprintBrowserConsent = consent.verifyAndFingerprint;
export const revokeLocalBrowserConsent = consent.revoke;
