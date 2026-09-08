/**
 * The two things a launching client can tell us that we cannot see for
 * ourselves: WHICH client it is, and WHAT CI job it is running inside.
 *
 * `testSuiteRun.source` is stamped `"api"` at this boundary and is deliberately
 * not caller-settable — that is what makes it usable as an audit field. The
 * cost is that the CLI, a GitHub Action running the CLI, and an MCP agent
 * driving the platform tools all badge identically, which is true and useless.
 * `x-mcpjam-launcher` carries the DECLARED label that fills that gap, and
 * `x-mcpjam-ci` the commit/branch/pipeline envelope that makes a CI launch
 * findable by `--baseline-sha`.
 *
 * WHY HEADERS RATHER THAN THE BODY. Both `/v1` eval-run bodies are `.strict()`,
 * so a new body field is a 400 on any server that predates it — self-hosted
 * deployments and staging included — while an unknown header is ignored
 * everywhere. A label whose whole purpose is cosmetic must never be able to
 * fail a launch.
 *
 * WHY THEY ARE PARSED HERE AND NOT VALIDATED AS A ROUTE SCHEMA. Same reason:
 * everything in this module DROPS what it does not understand rather than
 * refusing. A launcher kind we have never heard of, a 10KB CI blob, malformed
 * JSON — each of those loses the label and keeps the run. The backend
 * validators are the real gate; this is a lenient reader in front of them.
 *
 * None of it is trusted. The verified half of run provenance is
 * `attribution`, minted from the credential (see `agent-attribution.ts`), and
 * the client's origin badge prefers it wherever it exists.
 */

import type { Context } from "hono";

/** Mirrors the backend's `RUN_LAUNCHER_KINDS`. */
export const LAUNCHER_KINDS = ["cli", "mcp", "github_action"] as const;

export type LauncherKind = (typeof LAUNCHER_KINDS)[number];

export type RunLauncher = {
  kind: LauncherKind;
  client?: string;
  version?: string;
};

export type RunCiMetadata = {
  provider?: string;
  pipelineId?: string;
  jobId?: string;
  runUrl?: string;
  branch?: string;
  commitSha?: string;
};

export const LAUNCH_CONTEXT_HEADERS = {
  launcher: "x-mcpjam-launcher",
  ci: "x-mcpjam-ci",
} as const;

/**
 * Size caps, enforced on the RAW header before parsing.
 *
 * A header this size cannot be a legitimate launcher label or CI envelope, and
 * parsing a megabyte of JSON to discover that is the denial-of-service the cap
 * exists to avoid. Generous enough for a long `runUrl` plus every field.
 */
export const MAX_LAUNCHER_HEADER_BYTES = 512;
export const MAX_CI_HEADER_BYTES = 2048;

/** Display strings are rendered in a table cell, never parsed. */
const MAX_LAUNCHER_FIELD_CHARS = 128;
/** CI strings are keys and URLs; 512 holds a sha, a branch and a run URL. */
const MAX_CI_FIELD_CHARS = 512;

const LAUNCHER_KIND_SET: ReadonlySet<string> = new Set(LAUNCHER_KINDS);

function parseJsonHeader(
  raw: string | undefined,
  maxBytes: number,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  // Byte length, not character count: the cap is about what we agreed to read,
  // and a multi-byte payload that measures short in characters is not short.
  if (Buffer.byteLength(raw, "utf8") > maxBytes) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function cleanString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxChars);
}

/**
 * The declared launcher on this request, or `undefined`.
 *
 * Unknown keys are dropped rather than forwarded: the backend validator is an
 * exact object, so passing a field it does not declare would turn a cosmetic
 * label into a failed launch — precisely the outcome the header transport was
 * chosen to avoid.
 */
export function parseLauncherHeader(
  raw: string | undefined,
): RunLauncher | undefined {
  const parsed = parseJsonHeader(raw, MAX_LAUNCHER_HEADER_BYTES);
  if (!parsed) return undefined;
  const kind = typeof parsed.kind === "string" ? parsed.kind.trim() : "";
  // `api`, `sdk`, `ui` and `schedule` land here: they are server-stamped, so a
  // client claiming one is either confused or lying, and either way the label
  // is dropped and the run proceeds under its real `source`.
  if (!LAUNCHER_KIND_SET.has(kind)) return undefined;
  const client = cleanString(parsed.client, MAX_LAUNCHER_FIELD_CHARS);
  const version = cleanString(parsed.version, MAX_LAUNCHER_FIELD_CHARS);
  return {
    kind: kind as LauncherKind,
    ...(client ? { client } : {}),
    ...(version ? { version } : {}),
  };
}

/**
 * The CI envelope on this request, mapped onto the RUN's field names.
 *
 * The SDK's `detectCiMetadata` speaks GitHub's vocabulary (`runId`, `job`,
 * `repository`, `workflow`); `testSuiteRun.ciMetadata` speaks a
 * provider-neutral one (`pipelineId`, `jobId`). The translation happens here,
 * once, at the boundary — the alternative is every client learning the storage
 * shape, and a GitLab client having to pretend to be GitHub to fill it.
 *
 * Fields with no home in the run shape (`repository`, `workflow`,
 * `pullRequestNumber`) are dropped rather than crammed into a neighbour: a
 * `jobId` that sometimes means the workflow name is worse than an absent one.
 */
export function parseCiHeader(
  raw: string | undefined,
): RunCiMetadata | undefined {
  const parsed = parseJsonHeader(raw, MAX_CI_HEADER_BYTES);
  if (!parsed) return undefined;
  const ci: RunCiMetadata = {
    ...(cleanString(parsed.provider, MAX_CI_FIELD_CHARS)
      ? { provider: cleanString(parsed.provider, MAX_CI_FIELD_CHARS)! }
      : {}),
    // `pipelineId` ← `pipelineId` when the client already speaks the run
    // shape, else `runId` from the GitHub-flavoured detector.
    ...(cleanString(parsed.pipelineId ?? parsed.runId, MAX_CI_FIELD_CHARS)
      ? {
          pipelineId: cleanString(
            parsed.pipelineId ?? parsed.runId,
            MAX_CI_FIELD_CHARS,
          )!,
        }
      : {}),
    ...(cleanString(parsed.jobId ?? parsed.job, MAX_CI_FIELD_CHARS)
      ? {
          jobId: cleanString(parsed.jobId ?? parsed.job, MAX_CI_FIELD_CHARS)!,
        }
      : {}),
    ...(cleanString(parsed.runUrl, MAX_CI_FIELD_CHARS)
      ? { runUrl: cleanString(parsed.runUrl, MAX_CI_FIELD_CHARS)! }
      : {}),
    ...(cleanString(parsed.branch, MAX_CI_FIELD_CHARS)
      ? { branch: cleanString(parsed.branch, MAX_CI_FIELD_CHARS)! }
      : {}),
    ...(cleanString(parsed.commitSha, MAX_CI_FIELD_CHARS)
      ? { commitSha: cleanString(parsed.commitSha, MAX_CI_FIELD_CHARS)! }
      : {}),
  };
  // An envelope that survived with no usable field stores nothing, rather than
  // an object of `undefined`s that reads as "we recorded CI metadata".
  return Object.keys(ci).length > 0 ? ci : undefined;
}

export type LaunchContext = {
  launcher?: RunLauncher;
  ciMetadata?: RunCiMetadata;
};

/** Read both headers off a request. Absent or unreadable ⇒ absent. */
export function readLaunchContext(c: Context): LaunchContext {
  const launcher = parseLauncherHeader(
    c.req.header(LAUNCH_CONTEXT_HEADERS.launcher),
  );
  const ciMetadata = parseCiHeader(c.req.header(LAUNCH_CONTEXT_HEADERS.ci));
  return {
    ...(launcher ? { launcher } : {}),
    ...(ciMetadata ? { ciMetadata } : {}),
  };
}
