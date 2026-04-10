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

export function usageError(message: string, details?: unknown): CliError {
  return new CliError("USAGE_ERROR", message, 2, details);
}

export function operationalError(message: string, details?: unknown): CliError {
  return new CliError("OPERATIONAL_ERROR", message, 1, details);
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

  throw usageError(`Invalid output format "${value}". Use "json" or "human".`);
}

export function detectOutputFormatFromArgv(
  argv: readonly string[],
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

  return DEFAULT_OUTPUT_FORMAT;
}

function parseLooseOutputFormat(value: string | undefined): OutputFormat {
  return value === "human" ? "human" : DEFAULT_OUTPUT_FORMAT;
}

export function setProcessExitCode(code: number): void {
  process.exitCode = code;
}
