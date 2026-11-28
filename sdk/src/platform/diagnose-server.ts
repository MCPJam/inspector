/**
 * `diagnose_server` for a saved server that hosted MCPJam will not dial.
 *
 * A diagnosis answers "what is wrong with this server". When the answer is
 * that the hosted platform cannot reach it at all — a plain `http://` URL, a
 * local command, no URL — that IS the diagnosis, so it comes back as a report
 * whose connection check failed, not as an error. Raised as an error, the one
 * tool meant to explain a broken server looked broken itself: hosts render a
 * failed call, and an eval's tool-error gate fails the whole trial even when
 * the agent then explains the refusal correctly.
 *
 * Everything else still raises: an unknown server, a refused MCPJam
 * credential, an outage. Those are about the call, not about the server.
 */
import { createServerDoctorResult } from "../server-doctor-core.js";
import { PlatformApiError } from "./errors.js";
import {
  toSelectedProjectInfo,
  toServerInfo,
  type ResolvedServerInfo,
} from "./operation-support.js";
import type { SelectedProjectInfo } from "./show-servers.js";
import type {
  PlatformDoctorReport,
  PlatformProject,
  PlatformProjectServer,
} from "./types.js";

/** Why hosted MCPJam will not connect to a saved server. */
export type HostedReachRefusalReason =
  | "hosted_requires_https"
  | "hosted_stdio_unsupported"
  | "hosted_no_url";

export interface HostedReachRefusal {
  reason: HostedReachRefusalReason;
  /** What the platform said, when it was the platform that refused. */
  platformMessage?: string;
}

export interface RefusedDiagnosis {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  report: PlatformDoctorReport;
}

/**
 * The refusals knowable from the saved row alone, decided before any live
 * call — the same two `resolveLiveServer` raises for every other live op.
 */
export function hostedReachRefusalForServer(
  server: PlatformProjectServer
): HostedReachRefusal | undefined {
  if (server.transportType === "stdio") {
    return { reason: "hosted_stdio_unsupported" };
  }
  if (!server.url) return { reason: "hosted_no_url" };
  return undefined;
}

/**
 * The platform's own refusal to dial the server, read from the wire
 * envelope's `details.refusalReason` (`server-refusal.ts` in the Inspector
 * server sets it). Any other error is not a refusal of the server.
 */
export function hostedReachRefusalFromError(
  error: unknown
): HostedReachRefusal | undefined {
  if (!(error instanceof PlatformApiError)) return undefined;
  if (error.code !== "FEATURE_NOT_SUPPORTED") return undefined;
  const reason = error.details?.refusalReason;
  if (reason === "hosted_requires_https" || reason === "hosted_stdio_unsupported") {
    return { reason, platformMessage: error.message };
  }
  return undefined;
}

function refusalDetail(
  server: PlatformProjectServer,
  reason: HostedReachRefusalReason
): string {
  const name = `"${server.name}"`;
  switch (reason) {
    case "hosted_requires_https":
      return `Not attempted: ${name} uses an http:// URL, and hosted MCPJam connects only to https:// URLs. Serve it over HTTPS (\`mcpjam cloud tunnel\` gives a local server a public https:// URL), or diagnose it locally with \`mcpjam server doctor\` or the Inspector.`;
    case "hosted_stdio_unsupported":
      return `Not attempted: ${name} runs as a local command (stdio), which hosted MCPJam cannot start. Diagnose it locally with \`mcpjam server doctor\` or the Inspector.`;
    case "hosted_no_url":
      return `Not attempted: ${name} has no URL saved, so there is nothing to connect to. Save the server's URL, then diagnose it again.`;
  }
}

/**
 * The report a refused server gets: every check skipped except the
 * connection, which failed with the reason and the next step, in the same
 * shape the doctor route returns for a server it could not reach.
 */
export function refusedDiagnosis(
  project: PlatformProject,
  server: PlatformProjectServer,
  refusal: HostedReachRefusal
): RefusedDiagnosis {
  const detail = refusalDetail(server, refusal.reason);
  const report = createServerDoctorResult(
    {
      kind: server.transportType,
      scope: "hosted",
      projectId: project.id,
      serverId: server.id,
      label: server.name,
      url: server.url ?? null,
    },
    { probeDetail: "HTTP probe did not run: hosted MCPJam does not connect to this server." }
  );
  report.status = "error";
  report.connection = { status: "error", detail };
  report.checks.connection = { status: "error", detail };
  report.error = {
    code: "FEATURE_NOT_SUPPORTED",
    message: refusal.platformMessage ?? detail,
    details: { refusalReason: refusal.reason },
  };
  return {
    project: toSelectedProjectInfo(project),
    server: toServerInfo(server),
    report,
  };
}
