/**
 * Terminal-driven MRTR (`input_required`) input collector for the CLI's
 * interactive `tools call` / `prompts get` / `resources read` verbs (MCP
 * 2026-07-28, spec §12.3).
 *
 * The SDK's `MCPClientManager` owns the multi-round-trip loop: once an MRTR
 * collector is registered (pre-connect, so `elicitation` is advertised), the
 * three verbs validate an `input_required` result, hand its embedded requests
 * to the collector, self-validate the collected content against each
 * `requestedSchema`, and retry the original operation. This module is only the
 * **terminal adapter** for that collector — it never drives the loop itself.
 *
 * Design notes:
 * - **stdout stays clean.** All prompts and status lines go to the `write` sink
 *   (stderr by default), so the machine-readable result on stdout is never
 *   polluted by interactive chatter.
 * - **Decline / cancel are responses, not exceptions** (§12.1). A user who
 *   declines or cancels produces an `ElicitResult`-shaped response; only a real
 *   abort (Ctrl-C / `signal`) rejects.
 * - **Non-interactive declines cleanly.** With no TTY, `--yes`, or CI, the
 *   collector never blocks: it declines every embedded request and returns.
 * - **URL mode never auto-opens.** The URL is printed as plain text and the
 *   user is asked for consent, per the CLI's no-auto-open policy.
 */

import * as readline from "node:readline/promises";
import type {
  InputResponses,
  MrtrInputCollector,
} from "@mcpjam/sdk";

/** An accept/decline/cancel decision for a single embedded elicitation. */
export type ElicitAction = "accept" | "decline" | "cancel";

/** A single form field parsed out of an elicitation's `requestedSchema`. */
export interface ElicitationField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "enum";
  required: boolean;
  title?: string;
  description?: string;
  /** Allowed values for an enum field (the wire values). */
  enumValues?: string[];
  /** Human labels aligned by index with {@link enumValues}, when provided. */
  enumNames?: string[];
}

/**
 * A minimal line-reader abstraction. The default implementation wraps
 * `node:readline/promises` over stdin→stderr; tests inject a scripted reader so
 * the collector is exercised without a TTY.
 */
export interface LineReader {
  /** Prints `prompt` (to the reader's own output) and resolves the typed line. */
  question(prompt: string): Promise<string>;
}

export interface StdinMrtrCollectorOptions {
  /** Injected reader (tests). Default: readline/promises over stdin → stderr. */
  reader?: LineReader;
  /** Status / prompt sink. Default: `process.stderr.write`. */
  write?: (text: string) => void;
  /**
   * When `true`, the collector declines every embedded request without
   * prompting. Resolve via {@link resolveNonInteractive}.
   */
  nonInteractive?: boolean;
  /** Abort signal; a triggered signal rejects (never a synthetic decline). */
  signal?: AbortSignal;
  /** Re-prompt attempts per field before giving up (default 3). */
  maxFieldAttempts?: number;
}

/** Raised when collection is aborted (mirrors a fetch-style `AbortError`). */
export class MrtrCollectAbortError extends Error {
  constructor(message = "MRTR input collection was aborted.") {
    super(message);
    this.name = "AbortError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface LooseElicitRequest {
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Decides whether the interactive verb must fall back to a clean decline. True
 * when the user asked for it (`--yes`), when running under CI, or when stdin is
 * not a TTY (piped / redirected with no `--yes` — nothing to prompt).
 */
export function resolveNonInteractive(args: {
  yes?: boolean;
  stdinIsTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (args.yes) return true;
  const env = args.env ?? process.env;
  if (env.CI || env.MCPJAM_NON_INTERACTIVE) return true;
  return args.stdinIsTTY !== true;
}

/**
 * Parses an elicitation `requestedSchema` (`{ type:'object', properties,
 * required }`) into an ordered list of prompt-able fields. Unknown / unsupported
 * property shapes fall back to a free-text string field so the user can still
 * answer; the SDK's strict self-validation is the real enforcement boundary.
 */
export function parseElicitationFields(requestedSchema: unknown): ElicitationField[] {
  if (!isRecord(requestedSchema)) return [];
  const properties = requestedSchema.properties;
  if (!isRecord(properties)) return [];
  const required = new Set(
    Array.isArray(requestedSchema.required)
      ? requestedSchema.required.filter((v): v is string => typeof v === "string")
      : [],
  );

  const fields: ElicitationField[] = [];
  for (const key of Object.keys(properties)) {
    const prop = properties[key];
    if (!isRecord(prop)) {
      fields.push({ key, type: "string", required: required.has(key) });
      continue;
    }
    const title = typeof prop.title === "string" ? prop.title : undefined;
    const description =
      typeof prop.description === "string" ? prop.description : undefined;

    if (Array.isArray(prop.enum)) {
      const enumValues = prop.enum.map((v) => String(v));
      const enumNames = Array.isArray(prop.enumNames)
        ? prop.enumNames.map((v) => String(v))
        : undefined;
      fields.push({
        key,
        type: "enum",
        required: required.has(key),
        title,
        description,
        enumValues,
        ...(enumNames ? { enumNames } : {}),
      });
      continue;
    }

    const rawType = typeof prop.type === "string" ? prop.type : "string";
    const type: ElicitationField["type"] =
      rawType === "number"
        ? "number"
        : rawType === "integer"
          ? "integer"
          : rawType === "boolean"
            ? "boolean"
            : "string";
    fields.push({ key, type, required: required.has(key), title, description });
  }
  return fields;
}

/**
 * Coerces a raw terminal line into the field's typed value. Returns
 * `{ skip: true }` for an empty answer to an optional field (the key is
 * omitted). Throws on an un-coercible answer so the caller can re-prompt.
 */
export function coerceFieldValue(
  raw: string,
  field: ElicitationField,
): { skip: true } | { value: unknown } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    if (field.required) {
      throw new Error(`"${field.key}" is required.`);
    }
    return { skip: true };
  }

  switch (field.type) {
    case "string":
      return { value: raw };
    case "number": {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) throw new Error(`"${trimmed}" is not a number.`);
      return { value: n };
    }
    case "integer": {
      const n = Number(trimmed);
      if (!Number.isInteger(n)) throw new Error(`"${trimmed}" is not an integer.`);
      return { value: n };
    }
    case "boolean": {
      const lowered = trimmed.toLowerCase();
      if (["y", "yes", "true", "1"].includes(lowered)) return { value: true };
      if (["n", "no", "false", "0"].includes(lowered)) return { value: false };
      throw new Error(`Enter yes/no for "${field.key}".`);
    }
    case "enum": {
      const values = field.enumValues ?? [];
      if (values.includes(trimmed)) return { value: trimmed };
      // Allow selection by 1-based index.
      const idx = Number(trimmed);
      if (Number.isInteger(idx) && idx >= 1 && idx <= values.length) {
        return { value: values[idx - 1] };
      }
      throw new Error(
        `Choose one of: ${values.join(", ")} (or its number).`,
      );
    }
  }
}

/**
 * Builds a terminal MRTR input collector. Register it via
 * `manager.setMrtrInputCollector(serverId, collector)` **before connect**.
 */
export function createStdinMrtrCollector(
  options: StdinMrtrCollectorOptions = {},
): MrtrInputCollector {
  const write = options.write ?? ((text: string) => void process.stderr.write(text));
  const maxFieldAttempts = options.maxFieldAttempts ?? 3;

  return async ({ inputRequests, signal }) => {
    const activeSignal = signal ?? options.signal;
    throwIfAborted(activeSignal);

    const keys = Object.keys(inputRequests);
    const responses: Record<string, unknown> = {};

    if (options.nonInteractive) {
      write(
        `Non-interactive mode: declining ${keys.length} embedded input ` +
          `request(s). Re-run in a TTY (without --yes) to answer interactively.\n`,
      );
      for (const key of keys) responses[key] = { action: "decline" };
      return responses as InputResponses;
    }

    const ownReader = options.reader === undefined;
    const reader = options.reader ?? createReadlineReader();
    try {
      let cancelled = false;
      for (const key of keys) {
        if (cancelled) {
          responses[key] = { action: "cancel" };
          continue;
        }
        responses[key] = await collectOne(
          key,
          inputRequests[key] as LooseElicitRequest,
          { reader, write, maxFieldAttempts, signal: activeSignal },
        );
        if ((responses[key] as { action?: string }).action === "cancel") {
          cancelled = true;
        }
      }
      return responses as InputResponses;
    } finally {
      if (ownReader) closeReadlineReader(reader);
    }
  };
}

async function collectOne(
  key: string,
  request: LooseElicitRequest,
  ctx: {
    reader: LineReader;
    write: (text: string) => void;
    maxFieldAttempts: number;
    signal?: AbortSignal;
  },
): Promise<{ action: ElicitAction; content?: Record<string, unknown> }> {
  const params = request.params ?? {};
  const message = typeof params.message === "string" ? params.message : undefined;
  const mode = params.mode === "url" ? "url" : "form";

  ctx.write("\n");
  ctx.write(message ? `${message}\n` : `Input requested ("${key}"):\n`);

  if (mode === "url") {
    const url = typeof params.url === "string" ? params.url : "(no URL provided)";
    // Plain text only — the CLI never auto-opens a browser.
    ctx.write(`Open this URL to continue, then confirm below:\n  ${url}\n`);
    const action = await askAction(ctx.reader, ctx.write, ctx.signal, {
      acceptLabel: "approve",
    });
    return { action };
  }

  const action = await askAction(ctx.reader, ctx.write, ctx.signal, {
    acceptLabel: "accept",
  });
  if (action !== "accept") {
    return { action };
  }

  const fields = parseElicitationFields(params.requestedSchema);
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const label = field.title ?? field.key;
    if (field.description) ctx.write(`  ${field.description}\n`);
    if (field.type === "enum") {
      const values = field.enumValues ?? [];
      values.forEach((value, index) => {
        const name = field.enumNames?.[index];
        ctx.write(`    ${index + 1}) ${value}${name ? ` — ${name}` : ""}\n`);
      });
    }
    const suffix = field.required ? "" : " (optional, blank to skip)";
    let coerced: { skip: true } | { value: unknown } | undefined;
    for (let attempt = 1; attempt <= ctx.maxFieldAttempts; attempt += 1) {
      throwIfAborted(ctx.signal);
      const raw = await ctx.reader.question(
        `${label} [${field.type}]${suffix}: `,
      );
      try {
        coerced = coerceFieldValue(raw, field);
        break;
      } catch (error) {
        ctx.write(`  ${(error as Error).message}\n`);
        if (attempt === ctx.maxFieldAttempts) {
          throw new Error(
            `Could not collect a valid value for "${field.key}" after ` +
              `${ctx.maxFieldAttempts} attempts.`,
          );
        }
      }
    }
    if (coerced && "value" in coerced) {
      content[field.key] = coerced.value;
    }
  }
  return { action: "accept", content };
}

async function askAction(
  reader: LineReader,
  write: (text: string) => void,
  signal: AbortSignal | undefined,
  opts: { acceptLabel: string },
): Promise<ElicitAction> {
  for (;;) {
    throwIfAborted(signal);
    const raw = (
      await reader.question(
        `[a]${opts.acceptLabel.slice(1)} / [d]ecline / [c]ancel: `,
      )
    )
      .trim()
      .toLowerCase();
    if (raw === "a" || raw === opts.acceptLabel) return "accept";
    if (raw === "d" || raw === "decline") return "decline";
    if (raw === "c" || raw === "cancel") return "cancel";
    write(`  Please answer a, d, or c.\n`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new MrtrCollectAbortError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// ── Default readline reader ────────────────────────────────────────────────

interface ClosableLineReader extends LineReader {
  close?: () => void;
}

function createReadlineReader(): ClosableLineReader {
  const rl = readline.createInterface({
    input: process.stdin,
    // Prompts to stderr so stdout stays a clean machine-readable result.
    output: process.stderr,
  });
  return {
    question: (prompt: string) => rl.question(prompt),
    close: () => rl.close(),
  };
}

function closeReadlineReader(reader: LineReader): void {
  (reader as ClosableLineReader).close?.();
}
