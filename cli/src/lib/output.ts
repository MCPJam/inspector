import {
  extractAuthChallenge,
  isUnauthorized401,
  type AuthChallengeSignal,
} from "@mcpjam/sdk";

export type OutputFormat = "json" | "human";

const DEFAULT_OUTPUT_FORMAT: OutputFormat = "json";

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    exitCode: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function cliError(
  code: string,
  message: string,
  exitCode = 1,
  details?: unknown,
): CliError {
  return new CliError(code, message, exitCode, details);
}

export function usageError(message: string, details?: unknown): CliError {
  return new CliError("USAGE_ERROR", message, 2, details);
}

export function operationalError(message: string, details?: unknown): CliError {
  return new CliError("OPERATIONAL_ERROR", message, 1, details);
}

/**
 * A challenge's `scope` is the server's text, and it lands inside a command a
 * person may paste into a shell. Quoted as-is it could expand there, so only
 * plain scope tokens are shown; anything else becomes a placeholder.
 */
export function displayableScope(scope: string | undefined): string | undefined {
  if (scope === undefined) return undefined;
  return /^[A-Za-z0-9._:/@+-]+(?: [A-Za-z0-9._:/@+-]+)*$/.test(scope)
    ? scope
    : "<scopes>";
}

/**
 * The command that obtains a token for a server that asked for sign-in.
 * `--scopes` only when the challenge named them; otherwise the server's
 * metadata decides.
 */
export function authChallengeHint(
  challenge: Pick<AuthChallengeSignal, "requiredScope">,
  serverUrl?: string,
): string {
  const scope = displayableScope(challenge.requiredScope);
  const scopes = scope ? ` --scopes "${scope}"` : "";
  return `Sign in with \`mcpjam oauth login --url ${
    serverUrl ?? "<server-url>"
  }${scopes} --credentials-out <file>\`, then retry with \`--credentials-file <file>\`.`;
}

/**
 * Classify a server's sign-in challenge before anything reads the message
 * text: an `error_description` is the server's prose and may say "connect".
 */
function authChallengeCliError(
  error: unknown,
  message: string,
): CliError | undefined {
  const challenge = extractAuthChallenge(error);
  if (challenge?.source === "http_403_insufficient_scope") {
    return cliError("INSUFFICIENT_SCOPE", message, 1, {
      challenge,
      hint: authChallengeHint(challenge),
    });
  }
  if (challenge?.source === "http_401") {
    return cliError("AUTH_REQUIRED", message, 1, {
      challenge,
      hint: authChallengeHint(challenge),
    });
  }
  // An MCP client auth failure that kept no challenge (e.g. a connect-time
  // 401). Narrow on purpose: an MCPJam API 401 is a different problem with a
  // different fix, and must not be told to run `oauth login`.
  const name = error instanceof Error ? error.name : undefined;
  if (
    (name === "MCPAuthError" || name === "UnauthorizedError") &&
    isUnauthorized401(error)
  ) {
    return cliError("AUTH_REQUIRED", message, 1, {
      hint: authChallengeHint({}),
    });
  }
  return undefined;
}

export function normalizeCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }

  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";

  const authError = authChallengeCliError(error, message);
  if (authError) {
    return authError;
  }

  const lower = message.toLowerCase();

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return cliError("TIMEOUT", message);
  }

  if (
    /\bconnection (refused|reset|closed)\b/.test(lower) ||
    /\bconnect\b/.test(lower) ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound")
  ) {
    return cliError("SERVER_UNREACHABLE", message);
  }

  return cliError("INTERNAL_ERROR", message);
}

type StructuredError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

function stringify(value: unknown, format: OutputFormat): string {
  return format === "human"
    ? JSON.stringify(value, null, 2)
    : JSON.stringify(value);
}

export function writeResult(
  value: unknown,
  format: OutputFormat = DEFAULT_OUTPUT_FORMAT,
): void {
  process.stdout.write(`${stringify(value, format)}\n`);
}

export function toStructuredError(error: unknown): StructuredError {
  if (error instanceof CliError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  if (error instanceof Error) {
    return {
      error: {
        code: "UNEXPECTED_ERROR",
        message: error.message,
      },
    };
  }

  return {
    error: {
      code: "UNEXPECTED_ERROR",
      message: typeof error === "string" ? error : "Unknown error",
    },
  };
}

export function writeError(
  error: unknown,
  format: OutputFormat = DEFAULT_OUTPUT_FORMAT,
): StructuredError {
  const payload = toStructuredError(error);
  process.stderr.write(`${stringify(payload, format)}\n`);
  return payload;
}

export function parseOutputFormat(value: string): OutputFormat {
  if (value === "json" || value === "human") {
    return value;
  }

  rejectReporterFormatAsOutputFormat(value);

  throw usageError(`Invalid output format "${value}". Use "json" or "human".`);
}

export function rejectReporterFormatAsOutputFormat(value: string): void {
  if (value === "junit-xml" || value === "json-summary") {
    throw usageError(
      `Invalid output format "${value}". Use --reporter ${value} for CI reporter output.`,
    );
  }
}

export function resolveOutputFormat(
  value: string | undefined,
  isTTY: boolean,
): OutputFormat {
  return parseOutputFormat(value ?? (isTTY ? "human" : "json"));
}

export function detectOutputFormatFromArgv(
  argv: readonly string[],
  isTTY = process.stdout.isTTY,
): OutputFormat {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--format") {
      return parseLooseOutputFormat(argv[index + 1]);
    }

    if (token.startsWith("--format=")) {
      return parseLooseOutputFormat(token.slice("--format=".length));
    }
  }

  return isTTY ? "human" : DEFAULT_OUTPUT_FORMAT;
}

function parseLooseOutputFormat(value: string | undefined): OutputFormat {
  return value === "human" ? "human" : DEFAULT_OUTPUT_FORMAT;
}

export function setProcessExitCode(code: number): void {
  process.exitCode = code;
}
