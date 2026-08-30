/**
 * Wire-boundary guards for `io.modelcontextprotocol/skills` (SEP-2640)
 * payloads. Every guard validates against the vendored zod mirrors in
 * `skills-ext-schemas.ts` — untrusted server input is never merely sniffed.
 *
 * Mirrors `tasks-ext-guards.ts` in structure (a dedicated error type carrying
 * a truncated, control-character-free issue list) because the failure mode is
 * the same: the caller is a debugger, and "invalid result" without the field
 * that failed is not a diagnosis.
 */

import {
  directoryReadResultSchema,
  skillEntrySchema,
  skillsGetResultSchema,
  skillsListResultSchema,
} from "./skills-ext-schemas.js";
import type {
  SkillEntry,
  SkillsDirectoryReadResult,
  SkillsExtListResult,
} from "./skills-ext-types.js";

/** Max issues / characters kept in the human-facing violation summary. */
const MAX_SUMMARY_ISSUES = 5;
const MAX_SUMMARY_LENGTH = 500;
const MAX_SEGMENT_LENGTH = 64;

/**
 * Server-controlled text (a skill URI becomes an issue path segment) is
 * truncated and stripped of control characters before it reaches a message or
 * a log line.
 */
function safeText(value: string, maxLength = MAX_SEGMENT_LENGTH): string {
  // Control characters would corrupt a terminal / log line.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength)}…`
    : cleaned;
}

/**
 * Thrown when a server sends a skills payload that fails validation.
 *
 * This is an INVALID-SERVER-RESPONSE condition, distinct from "this connection
 * does not speak the skills extension" ({@link MCPSkillsWireError}) and from
 * "the content did not match its digest" (`SkillIntegrityError`). All three
 * are separate because they call for different UI: a bad payload is a server
 * bug, an inactive wire is a configuration fact, and an integrity failure is a
 * security event.
 */
export class InvalidSkillsPayloadError extends TypeError {
  readonly issues: string[];
  /** The extension method whose response failed, e.g. `"skills/list"`. */
  readonly method?: string;
  /** Truncated, control-character-free violation summary, safe to log. */
  readonly summary: string;

  constructor(
    context: string,
    issues: string[],
    options?: { method?: string }
  ) {
    const summary = safeText(
      issues.slice(0, MAX_SUMMARY_ISSUES).join("; "),
      MAX_SUMMARY_LENGTH
    );
    super(
      `${context} is not a valid io.modelcontextprotocol/skills payload: ${summary}`
    );
    this.name = "InvalidSkillsPayloadError";
    this.issues = issues;
    if (options?.method !== undefined) {
      this.method = options.method;
    }
    this.summary = summary;
  }
}

/**
 * Type guard for {@link InvalidSkillsPayloadError}.
 *
 * `instanceof` the concrete class, not a `name` sniff: a name check accepts any
 * error that happens to carry the same string, and routes branch on this to
 * decide retry and status mapping.
 */
export function isInvalidSkillsPayloadError(
  error: unknown
): error is InvalidSkillsPayloadError {
  return error instanceof InvalidSkillsPayloadError;
}

/**
 * Raised when a `skills/*` call is attempted on a connection where the
 * extension is not mutually declared.
 *
 * Deliberately a THROW rather than an empty result: "this server has no
 * skills" and "this client never declared the extension" are different facts,
 * and collapsing them would let a capability bug read as an empty catalog.
 */
export class MCPSkillsWireError extends Error {
  readonly method: string;
  readonly serverId: string;
  readonly advertised: boolean;
  readonly declared: boolean;
  /**
   * Set when the extension IS mutually declared but an OPTIONAL setting the
   * method depends on is off — today only `directoryRead`.
   *
   * Its own field rather than folded into `declared`: the message is derived
   * from these fields, and reporting `declared: false` for a server that
   * declared correctly would name the wrong defect. In a debugger the
   * diagnostic message is the product.
   */
  readonly missingSetting?: string;

  constructor(args: {
    method: string;
    serverId: string;
    advertised: boolean;
    declared: boolean;
    missingSetting?: string;
  }) {
    const reason =
      args.missingSetting !== undefined
        ? `the server did not opt into the optional "${args.missingSetting}" setting of io.modelcontextprotocol/skills`
        : !args.advertised
          ? "this client did not advertise io.modelcontextprotocol/skills on the connection"
          : "the server did not declare io.modelcontextprotocol/skills";
    super(`Cannot send ${args.method} to "${args.serverId}": ${reason}.`);
    this.name = "MCPSkillsWireError";
    this.method = args.method;
    this.serverId = args.serverId;
    this.advertised = args.advertised;
    this.declared = args.declared;
    if (args.missingSetting !== undefined) {
      this.missingSetting = args.missingSetting;
    }
  }
}

export function isMCPSkillsWireError(
  error: unknown
): error is MCPSkillsWireError {
  return error instanceof MCPSkillsWireError;
}

/**
 * Flattens one zod issue, DESCENDING into union alternatives.
 *
 * A `z.union` reports its own failure as a single `invalid_union` issue whose
 * message is the useless "Invalid input", with the real per-field diagnoses
 * buried in a nested `errors` array-of-arrays — one entry per alternative. A
 * formatter that reads only the top level therefore turns
 * "resources.0.digest is missing" into "resources: Invalid input", which
 * defeats the entire reason these guards exist: naming WHICH field of WHICH
 * entry a server got wrong.
 *
 * Sub-issue paths are relative to the union's input, so the parent path is
 * prepended to rebuild the full address.
 */
function flattenIssue(issue: unknown, parentPath: string[]): string[] {
  const rawPath = Array.isArray((issue as { path?: unknown }).path)
    ? (issue as { path: unknown[] }).path.map((segment) =>
        safeText(String(segment))
      )
    : [];
  const path = [...parentPath, ...rawPath];

  const alternatives = (issue as { errors?: unknown }).errors;
  if (Array.isArray(alternatives)) {
    const nested = alternatives
      .flatMap((alternative) =>
        Array.isArray(alternative)
          ? alternative.flatMap((sub) => flattenIssue(sub, path))
          : []
      )
      .filter((text) => text.length > 0);
    // Only when an alternative actually explained something. An empty union
    // report still has to say the field failed rather than vanish.
    if (nested.length > 0) return nested;
  }

  const message = safeText(
    String((issue as { message?: unknown }).message ?? "invalid")
  );
  const joined = path.join(".");
  return [joined ? `${joined}: ${message}` : message];
}

function issuesOf(error: unknown): string[] {
  const zodIssues = (error as { issues?: unknown })?.issues;
  if (!Array.isArray(zodIssues)) {
    return [error instanceof Error ? error.message : String(error)];
  }
  return zodIssues.flatMap((issue) => flattenIssue(issue, []));
}

/** Validates a `skills/list` result, preserving SEP-2549 cache attributes. */
export function assertSkillsListResult(
  value: unknown,
  context = "skills/list result"
): SkillsExtListResult {
  const parsed = skillsListResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidSkillsPayloadError(context, issuesOf(parsed.error), {
      method: "skills/list",
    });
  }
  return parsed.data as SkillsExtListResult;
}

/**
 * Validates ONE skill entry — a listing element, or the contents of a
 * `skills/get` envelope.
 *
 * SEP-2640 gives the entry inside `skills/get` the same shape as a listing
 * element, so this shares the entry mirror rather than duplicating it. It does
 * NOT accept a `skills/get` result directly; see {@link assertSkillsGetResult}.
 */
export function assertSkillEntry(
  value: unknown,
  context = "skill entry"
): SkillEntry {
  const parsed = skillEntrySchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidSkillsPayloadError(context, issuesOf(parsed.error), {
      method: "skills/get",
    });
  }
  return parsed.data as SkillEntry;
}

/**
 * Validates a `skills/get` RESULT and unwraps it.
 *
 * The result is `{ skill: SkillEntry }`. Validating the envelope as though it
 * were the entry looks for `uri` at the top level, where a conforming server
 * never puts it — so every conforming server fails and only a server that
 * flattens the envelope passes. Unwrapping here keeps that shape knowledge in
 * the one place that mirrors the wire.
 */
export function assertSkillsGetResult(
  value: unknown,
  context = "skills/get result"
): SkillEntry {
  const parsed = skillsGetResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidSkillsPayloadError(context, issuesOf(parsed.error), {
      method: "skills/get",
    });
  }
  return parsed.data.skill as SkillEntry;
}

/** Validates a `resources/directory/read` result. */
export function assertDirectoryReadResult(
  value: unknown,
  context = "resources/directory/read result"
): SkillsDirectoryReadResult {
  const parsed = directoryReadResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidSkillsPayloadError(context, issuesOf(parsed.error), {
      method: "resources/directory/read",
    });
  }
  return parsed.data as SkillsDirectoryReadResult;
}
