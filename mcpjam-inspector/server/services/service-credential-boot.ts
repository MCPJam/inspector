/**
 * Boot-time half of `service-credential.ts`: one log line saying which
 * credential-backed capabilities this process has, and the hosted-mode check
 * that a replica is not booting half-configured.
 *
 * Kept apart from the module itself so that module stays free of the logger
 * (and its Sentry import graph) — every server file imports it.
 */
import { logger } from "../utils/logger.js";
import {
  describeServiceCredentialCapabilities,
  enforceHostedServiceCredential,
  formatServiceCredentialReport,
} from "./service-credential.js";
import {
  ACCEPT_LEGACY_SIGNING_KEY_ENV,
  signingSecretsStillAcceptingLegacy,
} from "../utils/signing-keys.js";

/**
 * Log the capability report and run the hosted-mode credential check. Throws
 * `HostedServiceCredentialError` only under `MCPJAM_REQUIRE_SERVICE_CREDENTIAL
 * =true`; otherwise a hosted replica without a usable credential logs an
 * error (Sentry) and keeps booting.
 *
 * Both production entries (`index.ts`, `app.ts`) call this once.
 */
export function reportServiceCredentialAtBoot(hosted: boolean): void {
  logger.info(
    formatServiceCredentialReport(describeServiceCredentialCapabilities()),
  );
  enforceHostedServiceCredential({
    hosted,
    onProblem: (message) => logger.error(`[service-credential] ${message}`),
  });
  const legacyAccepted = signingSecretsStillAcceptingLegacy();
  if (legacyAccepted.length) {
    logger.warn(
      `[service-credential] ${legacyAccepted.join(", ")} set, but signatures ` +
        "under the INSPECTOR_SERVICE_TOKEN-derived key are still accepted. " +
        `Set ${ACCEPT_LEGACY_SIGNING_KEY_ENV}=false once pre-switch history ` +
        "is covered by *_PREVIOUS (see docs/service-credential.md).",
    );
  }
}
