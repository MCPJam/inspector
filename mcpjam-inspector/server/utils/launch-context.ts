/**
 * WHO LAUNCHED THIS RUN, as the launching process declares it.
 *
 * ============================================================================
 * WHY THIS IS SEPARATE FROM `agent-attribution.ts`
 * ============================================================================
 *
 * That module answers the same question from the credential the gateway
 * VERIFIED, and it deliberately refuses to guess: an earlier version derived
 * `cli` / `mcp` from `user-agent` and was removed, because any API-key holder
 * could send exactly `mcpjam-cli/1.4.0` and have their writes recorded as
 * first-party CLI traffic. A forgeable label in an audit trail is worse than
 * no label, because it gets believed.
 *
 * Nothing here changes that. The run's `source` is still stamped `"api"` by
 * the route, and the verified attribution is still what the audit reads. This
 * is a THIRD, separate column whose entire contract is "the client said so" —
 * displayed as a badge, never consulted for authorization, and stored beside
 * the stamp rather than inside it. The value is that a Runs table stops
 * showing three different things (a CLI run, a GitHub Actions job, an MCP
 * agent) as one indistinguishable `API`.
 *
 * ============================================================================
 * WHY HEADERS RATHER THAN THE BODY
 * ============================================================================
 *
 * Both `/v1` eval-run bodies are `.strict()`. A new body field is therefore a
 * 400 on any server that predates it — self-hosted deployments and staging
 * included — so the first CLI release to send it would break against every
 * older Inspector. Unknown headers are ignored by every version of everything.
 *
 * The same reasoning is why an unparsable or out-of-allowlist header is
 * DROPPED here rather than refused: a launch must never fail because a label
 * was malformed. The backend's mutation validator refuses a bad `kind` at the
 * wire, which is the right place for a caller that reaches Convex directly;
 * this boundary's job is to make sure such a value never gets that far.
 */

import type { Context } from "hono";

export const LAUNCH_CONTEXT_HEADERS = {
  launcher: "x-mcpjam-launcher",
  ci: "x-mcpjam-ci",
} as const;

/**
 * The three origins the server cannot observe for itself. `api`, `sdk`, `ui`,
 * `schedule` and `github_check` are all stamped server-side, and a declared
 * field that could restate them would let a caller paint a `ui` badge on an
 * API run. Mirrors the backend's `RUN_LAUNCHER_KINDS`.
 */
export const LAUNCHER_KINDS = ["cli", "mcp", "github_action"] as const;

export type LauncherKind = (typeof LAUNCHER_KINDS)[number];

export type RunLauncher = {
  kind: LauncherKind;
  client?: string;
  version?: string;
};

/** The run row's CI envelope. `pipelineId`/`jobId` are its own spelling. */
export type RunCiMetadata = {
  provider?: string;
  pipelineId?: string;
  jobId?: string;
  runUrl?: string;
  branch?: string;
  commitSha?: string;
};

export type LaunchContext = {
  launcher?: RunLauncher;
  ciMetadata?: RunCiMetadata;
};

/**
 * Header size caps, enforced on the raw bytes before any parsing.
 *
 * These are caller-controlled strings that end up on a row every run list
 * reads. 512 B holds a kind plus a generous client name and version; 2 KB
 * holds a CI envelope with a long branch name and a run URL. Anything larger
 * is a caller sending something other than what this header is for, and it is
 * dropped whole rather than truncated — half a JSON document parses to
 * nothing useful anyway.
 */
export const MAX_LAUNCHER_HEADER_BYTES = 512;
export const MAX_CI_HEADER_BYTES = 2048;

/** Per-field cap, mirroring the backend's. */
const MAX_FIELD_CHARS = 200;
const MAX_CI_FIELD_CHARS = 512;

const LAUNCHER_KIND_SET: ReadonlySet<string> = new Set(LAUNCHER_KINDS);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function parseHeaderJson(
  raw: string | null | undefined,
  maxBytes: number,
): Record<string, unknown> | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (byteLength(trimmed) > maxBytes) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function cappedString(
  value: unknown,
  maxChars = MAX_FIELD_CHARS,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxChars);
}

/** Parse `x-mcpjam-launcher`. Unknown keys are dropped, not carried through. */
export function parseLauncherHeader(
  raw: string | null | undefined,
): RunLauncher | undefined {
  const parsed = parseHeaderJson(raw, MAX_LAUNCHER_HEADER_BYTES);
  if (!parsed) return undefined;
  const kind = typeof parsed.kind === "string" ? parsed.kind.trim() : "";
  if (!LAUNCHER_KIND_SET.has(kind)) return undefined;
  const client = cappedString(parsed.client);
  const version = cappedString(parsed.version);
  return {
    kind: kind as LauncherKind,
    ...(client ? { client } : {}),
    ...(version ? { version } : {}),
  };
}

/**
 * Parse `x-mcpjam-ci` into the RUN's envelope shape.
 *
 * Accepts both spellings on the way in. The SDK's CI detector grew up serving
 * conformance uploads, where the fields are named after GitHub's own
 * (`runId`, `job`); the run row calls the same two things `pipelineId` and
 * `jobId` because it has to describe GitLab and Buildkite too. Taking either
 * here — preferring the run's own spelling when a caller sends both — means
 * neither producer has to know which consumer it is talking to, and an older
 * CLI keeps working against a newer server.
 *
 * Fields the run row has no column for (`repository`, `pullRequestNumber`,
 * `workflow`) are dropped rather than stuffed somewhere: a run's provenance
 * that half-fits its schema is worse than one that fits.
 */
export function parseCiHeader(
  raw: string | null | undefined,
): RunCiMetadata | undefined {
  const parsed = parseHeaderJson(raw, MAX_CI_HEADER_BYTES);
  if (!parsed) return undefined;
  const envelope: RunCiMetadata = {
    ...pick("provider", parsed.provider),
    ...pick("pipelineId", parsed.pipelineId ?? parsed.runId),
    ...pick("jobId", parsed.jobId ?? parsed.job),
    ...pick("runUrl", httpUrlOnly(parsed.runUrl)),
    ...pick("branch", parsed.branch),
    ...pick("commitSha", parsed.commitSha),
  };
  return Object.keys(envelope).length > 0 ? envelope : undefined;
}

function pick(key: keyof RunCiMetadata, value: unknown): RunCiMetadata {
  const cleaned = cappedString(value, MAX_CI_FIELD_CHARS);
  return cleaned ? ({ [key]: cleaned } as RunCiMetadata) : {};
}

/**
 * `runUrl` is the one declared field the UI turns into an `href`.
 *
 * Every other field in this envelope is rendered as text, so the worst a
 * caller can do with them is write a misleading branch name. A URL is
 * different: `javascript:` and `data:` in an anchor are code the reader runs
 * by clicking, and this value is attacker-chosen for anyone holding an API
 * key. Absolute `http(s)` only — a relative path is dropped too, since it
 * would resolve against the app's own origin and could not name a pipeline
 * anywhere.
 *
 * Dropped, not refused, like everything else here: a launch never fails
 * because a label was wrong.
 */
function httpUrlOnly(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:"
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The declared launch context on this request, or `undefined` when it carried
 * none.
 *
 * `undefined` rather than `{}` because every caller downstream forwards this
 * conditionally, and an empty object is truthy — it would travel the whole way
 * to the mutation args as `launchContext: {}`, which says "the caller declared
 * something" about a request that declared nothing.
 */
export function readLaunchContext(c: Context): LaunchContext | undefined {
  const launcher = parseLauncherHeader(
    c.req.header(LAUNCH_CONTEXT_HEADERS.launcher),
  );
  const ciMetadata = parseCiHeader(c.req.header(LAUNCH_CONTEXT_HEADERS.ci));
  if (!launcher && !ciMetadata) return undefined;
  return {
    ...(launcher ? { launcher } : {}),
    ...(ciMetadata ? { ciMetadata } : {}),
  };
}
