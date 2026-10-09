/**
 * `GET /api/web/capabilities` — what this server can do without asking the
 * hosted app, so the client offers only what will work.
 *
 * Public on purpose: the answer is feature NAMES and a boolean, the same facts
 * the boot log prints, and the client needs them before (and regardless of)
 * sign-in. Never a value, never a length.
 */
import { Hono } from "hono";
import { HOSTED_MODE } from "../../config.js";
import { describeServiceCredentialCapabilities } from "../../services/service-credential.js";
import {
  DEFAULT_HOSTED_API_URL,
  resolveHostedApiOrigin,
} from "../../services/api-keys-relay.js";

const capabilities = new Hono();

capabilities.get("/", (c) => {
  const report = describeServiceCredentialCapabilities();
  let hostedUrl = DEFAULT_HOSTED_API_URL;
  try {
    hostedUrl = resolveHostedApiOrigin();
  } catch {
    // A misconfigured override is reported where it is used; here the
    // default is the honest answer.
  }
  c.header("Cache-Control", "no-store");
  return c.json({
    hostedMode: HOSTED_MODE,
    hostedServices: report.credential === "present",
    hostedUrl,
    /** Features that refuse here with the shared hosted-only answer. */
    hostedOnly: report.off,
    /** Features that work here without the credential, and how. */
    degraded: report.degraded,
  });
});

export default capabilities;
