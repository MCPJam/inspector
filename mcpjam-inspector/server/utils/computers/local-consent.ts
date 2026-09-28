/** Shell-only device capability. Existing file and exports remain compatible. */
import { join } from "node:path";
import { getLocalComputerWorkspaceRoot } from "./local-machine.js";
import { createDeviceConsent } from "../device-consent.js";
export const LOCAL_CONSENT_HEADER = "x-mcpjam-local-consent";
const consent = createDeviceConsent(() =>
  join(getLocalComputerWorkspaceRoot(), "consent.json"),
);
export const grantLocalComputerConsent = consent.grant;
export const verifyLocalComputerConsent = consent.verify;
export const getLocalConsentFingerprint = consent.fingerprint;
export const verifyAndFingerprintLocalConsent = consent.verifyAndFingerprint;
export const revokeLocalComputerConsent = consent.revoke;
