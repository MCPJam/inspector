import { stripVTControlCharacters } from "node:util";

/**
 * Where `bin/start.js` writes. Human mode: progress on stdout, warnings and
 * errors on stderr. `--json` mode: stdout carries exactly one `ready` event,
 * human progress is dropped, warnings and errors stay on stderr, and a
 * startup failure adds one `error` event line to stderr. Error output never
 * carries the session token.
 */

// Start flags that consume the next argument, so a value such as
// `--name --json` is not read as the flag. Keep in step with start.js.
const VALUE_FLAGS = new Set([
  "--ollama",
  "--port",
  "--config",
  "--server",
  "--url",
  "--name",
  "--server-name",
  "--tab",
  "--view",
  "--bearer",
  "--header",
  "-H",
  "-e",
]);

/** True when `--json` appears among the start flags, before `--` or the server command. */
export function hasJsonFlag(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") return true;
    if (arg === "--" || !arg.startsWith("-")) return false;
    if (VALUE_FLAGS.has(arg)) i++;
  }
  return false;
}

const REDACTED = "[redacted]";

/** Removes each secret, and any `token=` value, from text bound for error output. */
export function redactSecrets(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join(REDACTED);
  }
  return result.replace(/token=[^&\s"']+/g, `token=${REDACTED}`);
}

export function readyEventLine({ url, port }) {
  return `${JSON.stringify({ event: "ready", url, port: Number(port) })}\n`;
}

export function errorEventLine(message, secrets = []) {
  return `${JSON.stringify({
    event: "error",
    message: redactSecrets(stripVTControlCharacters(String(message)), secrets),
  })}\n`;
}

export function createStartOutput({
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  let json = false;
  let readySent = false;
  let errorSent = false;
  let firstError = null;
  const secrets = new Set();

  const fail = (message) => {
    if (!json || errorSent) return;
    errorSent = true;
    stderr(errorEventLine(message, [...secrets]));
  };

  return {
    get json() {
      return json;
    },
    useJson() {
      json = true;
    },
    addSecret(secret) {
      if (secret) secrets.add(secret);
    },
    /** Human progress: stdout, or nothing in `--json` mode. */
    out(text) {
      if (!json) stdout(`${text}\n`);
    },
    warn(text) {
      stderr(`${redactSecrets(text, [...secrets])}\n`);
    },
    /** `message` is the plain error; `text` is its decorated human line. */
    error(message, text = message) {
      firstError ??= message;
      stderr(`${redactSecrets(text, [...secrets])}\n`);
    },
    ready({ url, port }) {
      if (!json || readySent) return;
      readySent = true;
      stdout(readyEventLine({ url, port }));
    },
    fail,
    /** For `process.on("exit")`: a non-zero exit with no event yet reports the first error. */
    failOnExit(code) {
      if (code) fail(firstError ?? `MCPJam Inspector exited with code ${code}`);
    },
  };
}
