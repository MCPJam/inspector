import type { Context, MiddlewareHandler } from "hono";
import {
  CLI_REPORTING_VERSION,
  isOlderReportingCli,
} from "../../../shared/cli-reporting-version.js";
import { readLaunchContext } from "../../utils/launch-context.js";
import { v1Error } from "./envelope.js";

/** New work only: an upgrade must not strand an upload or block run reads. */
export function startsEval(method: string, path: string): boolean {
  return (
    method === "POST" &&
    (/\/eval-runs(?:\/[^/]+\/rerun)?\/?$/.test(path) ||
      /\/eval-run-groups\/?$/.test(path) ||
      /\/eval-ingest\/(?:start-run|report|runs\/start)\/?$/.test(path))
  );
}

export const requireCurrentEvalCli: MiddlewareHandler = async (c, next) => {
  if (!startsEval(c.req.method, c.req.path)) return next();
  // Version is a compatibility hint, never an identity or authorization proof.
  // UA covers older CLIs that predate the declared-launcher header.
  const userAgentVersion = /(?:^|\s)mcpjam-cli\/([^\s]+)/.exec(
    c.req.header("user-agent") ?? "",
  )?.[1];
  const launcher = readLaunchContext(c)?.launcher;
  const declaredVersion =
    launcher?.client === "mcpjam-cli" &&
    (launcher.kind === "cli" || launcher.kind === "github_action")
      ? launcher.version
      : undefined;
  const oldVersion = [userAgentVersion, declaredVersion].find(
    isOlderReportingCli,
  );
  if (oldVersion) return cliUpgradeResponse(c, oldVersion);
  return next();
};

/** Also used for local CLI starts, which declare their version in the body. */
export function cliUpgradeResponse(c: Context, version: unknown) {
  if (!isOlderReportingCli(version)) return undefined;
  return v1Error(
    c,
    "VALIDATION_ERROR",
    `CLI ${version} is too old to start or upload an eval. Update to CLI ${CLI_REPORTING_VERSION} or newer with npm install -g @mcpjam/cli@latest and retry. In CI, remove an older cli-version pin or set it to 6.`,
    {
      reason: "CLI_UPGRADE_REQUIRED",
      minimumCliVersion: CLI_REPORTING_VERSION,
      currentCliVersion: version,
    },
  );
}
