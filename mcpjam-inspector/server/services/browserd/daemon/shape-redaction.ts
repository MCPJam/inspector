/**
 * The daemon's half of the credential-shape scrub, and its kill switch.
 *
 * A separate module from `shared/secret-shape-redaction.ts` for one reason:
 * that one is PURE and is imported by the client bundle, where `process.env`
 * does not exist. The switch has to be read somewhere, and the daemon reads
 * its own environment exactly as `config.ts` does.
 *
 * WHY THE DAEMON AND NOT ONLY THE SERVER. The server scrubs too — it has to,
 * because it also talks to daemons older than this one. Doing it here as well
 * is not belt and braces: the daemon is where the string is first written down
 * (the ledger row, `/v1/trace`, the durable mirror), and a value scrubbed only
 * on the way out of the server is a value that was already recorded.
 *
 * @see shared/secret-shape-redaction.ts for what this does and does not catch.
 */
import { redactSecretShapes } from "../../../../shared/secret-shape-redaction";

/**
 * Read once, at module load.
 *
 * Unlike the server's own switches — which are functions so a test can change
 * the environment per case — this one is a constant because the daemon is a
 * process with one environment for its whole life, and the alternative is a
 * `process.env` read per console line.
 */
const ENABLED = process.env.MCPJAM_BROWSER_SHAPE_REDACTION !== "0";

/**
 * Scrub a MESSAGE on its way to a model: an error, a console line, a network
 * failure.
 *
 * NEVER page content. The accessibility tree, the page text, the DOM, a dialog
 * and a page tool's result are what the model is reading; a false positive
 * there hides the thing it is trying to act on, which is a worse failure than
 * the one this prevents.
 */
export function redactForModel(text: string): string {
  return ENABLED ? redactSecretShapes(text) : text;
}

/** Whether the scrub is on, for a caller that wants to skip work entirely. */
export function shapeRedactionEnabled(): boolean {
  return ENABLED;
}
