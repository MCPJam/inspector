import { readFileSync } from "node:fs";
import { usageError } from "./output.js";

export type JsonInputReadFile = (
  path: Parameters<typeof readFileSync>[0],
  encoding: BufferEncoding,
) => string;

const readTextFile: JsonInputReadFile = (path, encoding) =>
  readFileSync(path, encoding);

export class JsonInputContext {
  private stdinConsumer: string | undefined;

  constructor(private readonly readFile: JsonInputReadFile = readTextFile) {}

  readInputSource(value: string, label: string): string {
    if (value === "-") {
      if (this.stdinConsumer) {
        throw usageError(
          `Cannot read ${label} from stdin because stdin was already consumed by ${this.stdinConsumer}. Use @file for one of the JSON inputs.`,
        );
      }

      this.stdinConsumer = label;
      try {
        return this.readFile(0, "utf8");
      } catch (error) {
        throw usageError(`Failed to read ${label} from stdin.`, {
          source: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!value.startsWith("@")) {
      return value;
    }

    const filePath = value.slice(1);
    if (!filePath) {
      throw usageError(`${label} file path is required after @.`);
    }

    try {
      return this.readFile(filePath, "utf8");
    } catch (error) {
      throw usageError(`Failed to read ${label} file "${filePath}".`, {
        source: error instanceof Error ? error.message : String(error),
      });
    }
  }

  parseJsonInputValue(value: string | undefined, label: string): unknown {
    if (value === undefined) {
      return undefined;
    }

    const source = this.readInputSource(value, label);
    if (source.trim() === "") {
      throw usageError(`${label} input is empty.`);
    }

    try {
      return JSON.parse(source);
    } catch (error) {
      throw usageError(`${label} must be valid JSON.`, {
        source: error instanceof Error ? error.message : String(error),
      });
    }
  }

  parseJsonInputRecord(
    value: string | undefined,
    label: string,
  ): Record<string, unknown> | undefined {
    const parsed = this.parseJsonInputValue(value, label);
    if (parsed === undefined) {
      return undefined;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw usageError(`${label} must be a JSON object.`);
    }

    return parsed as Record<string, unknown>;
  }
}

const defaultJsonInputContext = new JsonInputContext();

export function readInputSource(value: string, label: string): string {
  return defaultJsonInputContext.readInputSource(value, label);
}

export function parseJsonInputValue(
  value: string | undefined,
  label: string,
): unknown {
  return defaultJsonInputContext.parseJsonInputValue(value, label);
}

export function parseJsonInputRecord(
  value: string | undefined,
  label: string,
): Record<string, unknown> | undefined {
  return defaultJsonInputContext.parseJsonInputRecord(value, label);
}
