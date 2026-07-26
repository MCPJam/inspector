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
  ElicitationHandler,
  InputResponses,
  MrtrInputCollector,
} from "@mcpjam/sdk";

/** An accept/decline/cancel decision for a single embedded elicitation. */
export type ElicitAction = "accept" | "decline" | "cancel";

/** A single form field parsed out of an elicitation's `requestedSchema`. */
export interface ElicitationField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "enum" | "array";
  required: boolean;
  title?: string;
  description?: string;
  /**
   * Allowed values for an enum field, or for an `array` field the allowed
   * values of each item when the items are enum-constrained (the wire values).
   */
  enumValues?: string[];
  /** Human labels aligned by index with {@link enumValues}, when provided. */
  enumNames?: string[];
  /**
   * For an `array` field, the scalar type each collected item is coerced to
   * when the items are NOT enum-constrained. Defaults to `"string"`.
   */
  itemType?: "string" | "number" | "integer" | "boolean";
  /**
   * Whether a blank answer is a schema-VALID value for this required field
   * rather than a miss: a required string with no positive `minLength` accepts
   * `""`, and a required array with no positive `minItems` accepts `[]`.
   * Rejecting those would make the elicitation impossible to complete, since a
   * required key can't be skipped. Always false for optional fields (a blank
   * answer there omits the key, which is the more useful default).
   */
  allowEmpty?: boolean;
  /**
   * Range/length bounds carried over from the requested schema, checked while
   * collecting so a violation costs one re-prompt instead of failing the whole
   * operation later: the SDK validates the completed content strictly, and by
   * then the field's remaining attempts are gone.
   */
  constraints?: FieldConstraints;
}

/** The subset of schema bounds the terminal collector can check as it prompts. */
export interface FieldConstraints {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

/**
 * A minimal line-reader abstraction. The default implementation wraps
 * `node:readline/promises` over stdin→stderr; tests inject a scripted reader so
 * the collector is exercised without a TTY.
 */
export interface LineReader {
  /**
   * Prints `prompt` (to the reader's own output) and resolves the typed line.
   * When an already- or later-aborted `signal` is supplied, the wait is
   * interrupted immediately rather than blocking until the user hits Enter.
   */
  question(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
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
 * Strips terminal control sequences from server-supplied text before it is
 * rendered next to a consent prompt.
 *
 * Elicitation messages, URLs, field labels and choice lists are attacker-
 * controlled: a raw `ESC[` sequence could repaint the screen, hide the real URL
 * the user is approving, or forge the `[a]pprove / [d]ecline` line. Everything
 * except tab is removed from the C0/C1 ranges (newlines included — a message is
 * rendered as one line so it cannot push the prompt out of view), and DEL too.
 */
export function sanitizeTerminalText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/g, " ");
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
 * The `elicitation` client capability an interactive verb must advertise.
 *
 * Bare `{}` is form-ONLY under the spec's mode semantics (and under this repo's
 * own `getSupportedElicitationModes` check), so a client that leaves it bare
 * never legitimately receives the url-mode request the terminal collector
 * implements. The collector handles both modes, so both are declared —
 * advertise exactly what is enforced.
 */
export const INTERACTIVE_ELICITATION_CAPABILITY = {
  form: {},
  url: {},
} as const;

/**
 * Builds the `beforeConnect` hook that registers a terminal MRTR input
 * collector when `--interactive` is set. Registration happens **before** the
 * manager connects so `elicitation` is advertised on the connect envelope — a
 * 2026-07-28 server only embeds `input_required` elicitations for a client that
 * declared the capability. Without `--interactive`, no collector is registered
 * and the verb behaves exactly as before (legacy fast path unchanged).
 *
 * Note there is no `--quiet` sink here: interactive output is the server's
 * message, the URL under consent, the choice list and the validation errors —
 * suppressing it would leave the user answering prompts they cannot read. It
 * all goes to stderr, so `--quiet`\'s actual contract (a clean, machine-readable
 * stdout) is unaffected.
 */
export function buildMrtrBeforeConnect(options: {
  interactive?: boolean;
  yes?: boolean;
}):
  | ((
      manager: import("@mcpjam/sdk").MCPClientManager,
      serverId: string,
    ) => void)
  | undefined {
  if (!options.interactive) return undefined;
  const nonInteractive = resolveNonInteractive({
    yes: options.yes,
    stdinIsTTY: Boolean(process.stdin.isTTY),
  });
  const collectorOptions = { nonInteractive };
  const collector = createStdinMrtrCollector(collectorOptions);
  const handler = createStdinElicitationHandler(collectorOptions);
  return (manager, serverId) => {
    manager.setMrtrInputCollector(serverId, collector);
    // Same capability, two deliveries: MRTR on 2026-07-28, an inbound request
    // on 2025-11-25 and earlier. Both are registered before connect, so the
    // advertised `elicitation` is answerable whichever version negotiates.
    manager.setElicitationHandler(serverId, handler);
  };
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

    // Single-select enum, expressed as `enum`, or as a `oneOf`/`anyOf` list of
    // `const` (or single-value `enum`) branches — the same forms the debugger's
    // elicitation parser accepts.
    const scalarEnum = extractEnum(prop);
    if (scalarEnum) {
      fields.push({
        key,
        type: "enum",
        required: required.has(key),
        title,
        description,
        enumValues: scalarEnum.values,
        ...(scalarEnum.names ? { enumNames: scalarEnum.names } : {}),
      });
      continue;
    }

    // Multi-select / array field. When the items are enum-constrained, present
    // the same choice list and collect a `string[]`; otherwise collect a list of
    // scalars coerced to the item type. A scalar answer here would fail the
    // SDK's strict schema validation, so the field would be unanswerable.
    if (prop.type === "array") {
      const items = isRecord(prop.items) ? prop.items : undefined;
      const itemEnum = items ? extractEnum(items) : undefined;
      const itemRawType =
        items && typeof items.type === "string" ? items.type : "string";
      const itemType: NonNullable<ElicitationField["itemType"]> =
        itemRawType === "number"
          ? "number"
          : itemRawType === "integer"
            ? "integer"
            : itemRawType === "boolean"
              ? "boolean"
              : "string";
      fields.push({
        key,
        type: "array",
        required: required.has(key),
        title,
        description,
        ...(itemEnum ? { enumValues: itemEnum.values } : {}),
        ...(itemEnum?.names ? { enumNames: itemEnum.names } : {}),
        ...(itemEnum ? {} : { itemType }),
        ...(required.has(key) && !isPositiveInteger(prop.minItems)
          ? { allowEmpty: true }
          : {}),
        ...withConstraints(prop),
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
    fields.push({
      key,
      type,
      required: required.has(key),
      title,
      description,
      ...(type === "string" &&
      required.has(key) &&
      !isPositiveInteger(prop.minLength)
        ? { allowEmpty: true }
        : {}),
      ...withConstraints(prop),
    });
  }
  return fields;
}

/**
 * Picks the schema bounds the collector can enforce at the prompt. Omitted
 * entirely when the schema carries none, so a field object stays minimal.
 */
function withConstraints(
  prop: Record<string, unknown>,
): { constraints: FieldConstraints } | Record<string, never> {
  const constraints: FieldConstraints = {};
  for (const key of [
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
  ] as const) {
    const value = prop[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      constraints[key] = value;
    }
  }
  if (typeof prop.pattern === "string" && prop.pattern !== "") {
    constraints.pattern = prop.pattern;
  }
  return Object.keys(constraints).length > 0 ? { constraints } : {};
}

/** True for a schema bound that actually forbids an empty value. */
function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Enforces the schema bounds the SDK would otherwise reject only after the
 * whole form is collected. Throwing here re-prompts the single offending field,
 * which is what the user can actually act on.
 */
function assertSatisfiesConstraints(
  value: unknown,
  field: ElicitationField,
): void {
  const c = field.constraints;
  if (!c) return;
  const name = sanitizeTerminalText(field.title ?? field.key);

  if (typeof value === "string") {
    if (c.minLength !== undefined && value.length < c.minLength) {
      throw new Error(`"${name}" must be at least ${c.minLength} character(s).`);
    }
    if (c.maxLength !== undefined && value.length > c.maxLength) {
      throw new Error(`"${name}" must be at most ${c.maxLength} character(s).`);
    }
    if (c.pattern !== undefined) {
      let re: RegExp | undefined;
      try {
        re = new RegExp(c.pattern);
      } catch {
        re = undefined; // Un-compilable server pattern: leave it to the SDK.
      }
      if (re && !re.test(value)) {
        throw new Error(
          `"${name}" must match ${sanitizeTerminalText(c.pattern)}.`,
        );
      }
    }
    return;
  }

  if (typeof value === "number") {
    if (c.minimum !== undefined && value < c.minimum) {
      throw new Error(`"${name}" must be >= ${c.minimum}.`);
    }
    if (c.maximum !== undefined && value > c.maximum) {
      throw new Error(`"${name}" must be <= ${c.maximum}.`);
    }
    return;
  }

  if (Array.isArray(value)) {
    if (c.minItems !== undefined && value.length < c.minItems) {
      throw new Error(`"${name}" needs at least ${c.minItems} item(s).`);
    }
    if (c.maxItems !== undefined && value.length > c.maxItems) {
      throw new Error(`"${name}" takes at most ${c.maxItems} item(s).`);
    }
  }
}

/**
 * Extracts an enum choice list from a schema node, accepting the three forms a
 * server may use: a direct `enum` array, or a `oneOf`/`anyOf` list whose
 * branches each carry a `const` (or a single-value `enum`). Returns `undefined`
 * when the node is not a closed choice set. `enumNames` / branch `title`s become
 * the aligned human labels when present.
 */
function extractEnum(
  node: Record<string, unknown>,
): { values: string[]; names?: string[] } | undefined {
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum.map((v) => String(v));
    const names = Array.isArray(node.enumNames)
      ? node.enumNames.map((v) => String(v))
      : undefined;
    return names ? { values, names } : { values };
  }

  const branches = Array.isArray(node.oneOf)
    ? node.oneOf
    : Array.isArray(node.anyOf)
      ? node.anyOf
      : undefined;
  if (!branches || branches.length === 0) return undefined;

  const values: string[] = [];
  const names: string[] = [];
  let anyName = false;
  for (const branch of branches) {
    if (!isRecord(branch)) return undefined;
    let value: unknown;
    if ("const" in branch) {
      value = branch.const;
    } else if (
      Array.isArray(branch.enum) &&
      branch.enum.length === 1
    ) {
      value = branch.enum[0];
    } else {
      return undefined; // Not a closed const/enum branch set — treat as free text.
    }
    values.push(String(value));
    const label =
      typeof branch.title === "string"
        ? branch.title
        : typeof branch.description === "string"
          ? branch.description
          : String(value);
    if (typeof branch.title === "string" || typeof branch.description === "string") {
      anyName = true;
    }
    names.push(label);
  }
  return anyName ? { values, names } : { values };
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
  const coerced = coerceFieldValueRaw(raw, field);
  if ("value" in coerced) assertSatisfiesConstraints(coerced.value, field);
  return coerced;
}

/** Type coercion only; {@link coerceFieldValue} adds the constraint check. */
function coerceFieldValueRaw(
  raw: string,
  field: ElicitationField,
): { skip: true } | { value: unknown } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    if (field.required) {
      // A blank answer is the schema-valid empty value when the field permits
      // one (`minLength`/`minItems` absent or zero) — rejecting it would leave
      // the required key unanswerable. Arrays fall through to the array case,
      // which produces `[]`.
      if (field.allowEmpty && field.type === "string") return { value: "" };
      if (!(field.allowEmpty && field.type === "array")) {
        throw new Error(`"${sanitizeTerminalText(field.key)}" is required.`);
      }
    } else {
      return { skip: true };
    }
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
      throw new Error(`Enter yes/no for "${sanitizeTerminalText(field.key)}".`);
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
        `Choose one of: ${sanitizeTerminalText(values.join(", "))} (or its number).`,
      );
    }
    case "array": {
      // Comma-separated list. For enum-constrained items each part is matched
      // by value or 1-based index; otherwise each part is coerced to the item
      // scalar type. Always returns an array so it satisfies the array schema.
      const parts = trimmed
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
      if (parts.length === 0) {
        if (!field.required) return { skip: true };
        if (field.allowEmpty) return { value: [] };
        throw new Error(`"${sanitizeTerminalText(field.key)}" is required.`);
      }
      const values = field.enumValues;
      if (values && values.length > 0) {
        const selected = parts.map((part) => {
          if (values.includes(part)) return part;
          const idx = Number(part);
          if (Number.isInteger(idx) && idx >= 1 && idx <= values.length) {
            return values[idx - 1];
          }
          throw new Error(
            `Choose from: ${sanitizeTerminalText(values.join(", "))} (comma-separated values or numbers).`,
          );
        });
        return { value: selected };
      }
      const itemType = field.itemType ?? "string";
      const coerced = parts.map((part) => {
        const one = coerceFieldValueRaw(part, {
          key: field.key,
          type: itemType,
          required: true,
        });
        // A required scalar never returns `{ skip: true }` for a non-blank part.
        return (one as { value: unknown }).value;
      });
      return { value: coerced };
    }
  }
}

/**
 * Terminal handler for an ordinary server-to-client `elicitation/create`.
 *
 * MRTR replaced server-initiated requests in the 2026-07-28 draft ("Servers
 * MUST send server-to-client requests using the MRTR pattern"), but every
 * earlier version a user can still connect to — 2025-06-18 and 2025-11-25 —
 * delivers elicitation as a real inbound request. Declaring the `elicitation`
 * capability with only an MRTR collector registered would therefore invite
 * requests the client answers with "method not found" on exactly those
 * versions: the server exposes its elicitation-using tools and they then fail
 * mid-call. Registering this alongside the collector keeps the advertisement
 * honest on both eras, using the same rendering and consent rules.
 *
 * Mode enforcement stays in the SDK, which rejects an inbound mode this client
 * did not declare before the request ever reaches here.
 */
export function createStdinElicitationHandler(
  options: StdinMrtrCollectorOptions = {},
): ElicitationHandler {
  const collector = createStdinMrtrCollector(options);
  return async (params) => {
    // Reuse the collector verbatim so the two eras cannot drift apart: one
    // embedded request under a fixed key, unwrapped back to a bare result.
    const responses = (await collector({
      state: {} as never,
      inputRequests: {
        [INBOUND_ELICITATION_KEY]: { method: "elicitation/create", params },
      } as never,
    })) as Record<string, { action: ElicitAction; content?: Record<string, unknown> }>;
    return responses[INBOUND_ELICITATION_KEY] as ReturnType<ElicitationHandler>;
  };
}

/** Synthetic key for the single request in the inbound-elicitation adapter. */
const INBOUND_ELICITATION_KEY = "elicitation";

/**
 * Builds a terminal MRTR input collector. Register it via
 * `manager.setMrtrInputCollector(serverId, collector)` **before connect**.
 */
export function createStdinMrtrCollector(
  options: StdinMrtrCollectorOptions = {},
): MrtrInputCollector {
  const write = options.write ?? ((text: string) => void process.stderr.write(text));
  // Normalize to a positive finite integer: a non-positive / NaN / fractional
  // value would otherwise skip the re-prompt loop entirely and let a required
  // field be accepted with no value collected.
  const rawAttempts = options.maxFieldAttempts;
  const maxFieldAttempts =
    typeof rawAttempts === "number" && Number.isInteger(rawAttempts) && rawAttempts >= 1
      ? rawAttempts
      : 3;

  return async ({ inputRequests, signal }) => {
    const activeSignal = signal ?? options.signal;
    throwIfAborted(activeSignal);

    const keys = Object.keys(inputRequests);
    // Null-prototype: server-assigned keys are untrusted, so a `__proto__` /
    // `constructor` key must become an own property, not mutate the prototype
    // (which would drop it from the retry payload and loop the round).
    const responses: Record<string, unknown> = Object.create(null);

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

  // Everything the server supplies is sanitized before it reaches the terminal:
  // it renders right next to the consent prompt, so a raw escape sequence could
  // hide the URL being approved or forge the prompt line itself.
  ctx.write("\n");
  ctx.write(
    message
      ? `${sanitizeTerminalText(message)}\n`
      : `Input requested ("${sanitizeTerminalText(key)}"):\n`,
  );

  if (mode === "url") {
    const url = typeof params.url === "string" ? params.url : "(no URL provided)";
    // Plain text only — the CLI never auto-opens a browser.
    ctx.write(
      `Open this URL to continue, then confirm below:\n  ${sanitizeTerminalText(url)}\n`,
    );
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
  // Null-prototype: field keys are server-assigned and untrusted (see above).
  const content: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const label = sanitizeTerminalText(field.title ?? field.key);
    if (field.description)
      ctx.write(`  ${sanitizeTerminalText(field.description)}\n`);
    if (field.type === "enum" || field.type === "array") {
      const values = field.enumValues ?? [];
      values.forEach((value, index) => {
        const name = field.enumNames?.[index];
        // Display only — the raw value is what gets matched and sent back.
        ctx.write(
          `    ${index + 1}) ${sanitizeTerminalText(value)}` +
            `${name ? ` — ${sanitizeTerminalText(name)}` : ""}\n`,
        );
      });
      if (field.type === "array") {
        ctx.write(`    (comma-separated for multiple)\n`);
      }
    }
    const suffix = !field.required
      ? " (optional, blank to skip)"
      : field.allowEmpty
        ? field.type === "array"
          ? " (required, blank for none)"
          : " (required, blank for empty)"
        : "";
    let coerced: { skip: true } | { value: unknown } | undefined;
    for (let attempt = 1; attempt <= ctx.maxFieldAttempts; attempt += 1) {
      throwIfAborted(ctx.signal);
      const raw = await ctx.reader.question(
        `${label} [${field.type}]${suffix}: `,
        { signal: ctx.signal },
      );
      try {
        coerced = coerceFieldValue(raw, field);
        break;
      } catch (error) {
        ctx.write(`  ${(error as Error).message}\n`);
        if (attempt === ctx.maxFieldAttempts) {
          // Decline, never reject: an unanswerable field is a response (§12.1),
          // and throwing here would discard the answers already collected for
          // the other keys in this round. Only a real abort rejects.
          ctx.write(
            `  Giving up on "${sanitizeTerminalText(field.key)}" after ` +
              `${ctx.maxFieldAttempts} attempts; declining this request.\n`,
          );
          return { action: "decline" };
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
        { signal },
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
    question: async (prompt: string, options?: { signal?: AbortSignal }) => {
      try {
        // `readline/promises` `question` accepts `{ signal }` (Node ≥ 20) and
        // rejects immediately with an AbortError when it fires mid-wait.
        return await (options?.signal
          ? rl.question(prompt, { signal: options.signal })
          : rl.question(prompt));
      } catch (error) {
        if (
          options?.signal?.aborted ||
          (error as { name?: string })?.name === "AbortError"
        ) {
          throw new MrtrCollectAbortError();
        }
        throw error;
      }
    },
    close: () => rl.close(),
  };
}

function closeReadlineReader(reader: LineReader): void {
  (reader as ClosableLineReader).close?.();
}
