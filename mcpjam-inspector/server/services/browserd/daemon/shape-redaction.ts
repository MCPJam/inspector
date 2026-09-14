/**
 * The daemon's credential-shape scrub and its kill switch. Separate from the
 * shared module because that one is imported by the client, which has no
 * `process.env`. Runs in the daemon, not only the server, because the daemon
 * first records the string (ledger, `/v1/trace`, durable mirror).
 */
import { redactSecretShapes } from "../../../../shared/secret-shape-redaction";

/** Read once: the daemon has one environment for its whole life. */
const ENABLED = process.env.MCPJAM_BROWSER_SHAPE_REDACTION !== "0";

/**
 * Scrub a message (error, console line, network failure) bound for a model.
 * Never page content: a false positive there hides what the model must act on.
 */
export function redactForModel(text: string): string {
  return ENABLED ? redactSecretShapes(text) : text;
}

/** Whether the scrub is on, for a caller that wants to skip work entirely. */
export function shapeRedactionEnabled(): boolean {
  return ENABLED;
}
