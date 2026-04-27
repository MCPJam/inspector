import { readFileSync } from "node:fs";
import { usageError } from "./output.js";

let stdinConsumer: string | undefined;

export function resetJsonInputStdinForTests(): void {
  stdinConsumer = undefined;
}

export function readInputSource(value: string, label: string): string {
  if (value === "-") {
    if (stdinConsumer) {
      throw usageError(
        `Cannot read ${label} from stdin because stdin was already consumed by ${stdinConsumer}. Use @file for one of the JSON inputs.`,
      );
    }

    stdinConsumer = label;
    return readFileSync(0, "utf8");
  }

  if (!value.startsWith("@")) {
    return value;
  }

  const filePath = value.slice(1);
  if (!filePath) {
    throw usageError(`${label} file path is required after @.`);
  }

  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    throw usageError(`Failed to read ${label} file "${filePath}".`, {
      source: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseJsonInputValue(
  value: string | undefined,
  label: string,
): unknown {
  if (value === undefined) {
    return undefined;
  }

  const source = readInputSource(value, label);

  try {
    return JSON.parse(source);
  } catch (error) {
    throw usageError(`${label} must be valid JSON.`, {
      source: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseJsonInputRecord(
  value: string | undefined,
  label: string,
): Record<string, unknown> | undefined {
  const parsed = parseJsonInputValue(value, label);
  if (parsed === undefined) {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError(`${label} must be a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}
