import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const resolutionMessages = {
  CLI_REGISTRY_TIMEOUT: "The npm registry request timed out.",
  CLI_NPM_NOT_FOUND: "The npm executable was not found on PATH.",
  CLI_REGISTRY_UNAVAILABLE: "npm could not read the CLI release metadata.",
  CLI_REGISTRY_INVALID_METADATA: "npm returned invalid CLI release metadata.",
  CLI_NO_STABLE_RELEASE: "No stable CLI release exists in the requested major.",
};

export class CliVersionResolutionError extends Error {
  constructor(code) {
    super(resolutionMessages[code]);
    this.code = code;
  }
}

/** Fixed diagnostics only: subprocess messages can contain registry credentials. */
export function cliResolutionDiagnostic(error) {
  return error instanceof CliVersionResolutionError
    ? (resolutionMessages[error.code] ??
        resolutionMessages.CLI_REGISTRY_UNAVAILABLE)
    : resolutionMessages.CLI_REGISTRY_UNAVAILABLE;
}

/** Resolve once so the run and every gate use the same published CLI. */
export async function resolveCliVersion(selector, run = execute) {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(selector)) return selector;
  if (!/^[1-9]\d*$/.test(selector))
    throw new Error("Unsupported CLI selector.");
  let stdout;
  try {
    ({ stdout } = await run(
      "npm",
      [
        "view",
        `@mcpjam/cli@${selector}`,
        "version",
        "--json",
        "--prefer-online",
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    ));
  } catch (error) {
    const code =
      error?.code === "ENOENT"
        ? "CLI_NPM_NOT_FOUND"
        : error?.killed || error?.code === "ETIMEDOUT"
          ? "CLI_REGISTRY_TIMEOUT"
          : "CLI_REGISTRY_UNAVAILABLE";
    throw new CliVersionResolutionError(code);
  }
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new CliVersionResolutionError("CLI_REGISTRY_INVALID_METADATA");
  }
  const versions = (Array.isArray(payload) ? payload : [payload]).filter(
    (value) =>
      typeof value === "string" &&
      /^\d+\.\d+\.\d+$/.test(value) &&
      value.split(".")[0] === selector,
  );
  versions.sort((a, b) => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    return left[1] - right[1] || left[2] - right[2];
  });
  if (!versions.length)
    throw new CliVersionResolutionError("CLI_NO_STABLE_RELEASE");
  return versions.at(-1);
}
