import type { Context, MiddlewareHandler } from "hono";
import { isCliVersionOlderThan } from "../../../shared/cli-reporting-version.js";
import { readLaunchContext } from "../../utils/launch-context.js";
import { v1Error } from "./envelope.js";

/** Set only after the task owner approves a customer-facing refusal policy. */
function minimumEvalCliVersion(): string | undefined {
  const minimum = process.env.MCPJAM_MINIMUM_EVAL_CLI_VERSION?.trim();
  if (!minimum) return undefined;
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(minimum) ||
    !minimum.split(".").map(Number).every(Number.isSafeInteger)
  ) {
    throw new Error(
      "MCPJAM_MINIMUM_EVAL_CLI_VERSION must be a stable semantic version.",
    );
  }
  return minimum;
}

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
  const minimum = minimumEvalCliVersion();
  if (!minimum) return next();
  const oldVersion = [userAgentVersion, declaredVersion].find((version) =>
    isCliVersionOlderThan(version, minimum),
  );
  if (oldVersion) return cliUpgradeResponse(c, oldVersion);
  return next();
};

/** Also used for local CLI starts, which declare their version in the body. */
export function cliUpgradeResponse(c: Context, version: unknown) {
  const minimum = minimumEvalCliVersion();
  if (!minimum || !isCliVersionOlderThan(version, minimum)) return undefined;
  return v1Error(
    c,
    "VALIDATION_ERROR",
    `CLI ${version} is too old to start or upload an eval. Update to CLI ${minimum} or newer. For the latest CLI, first use supported Node (^22.23.4 || ^24.22.1 || >=26.12.1), then run npm install -g @mcpjam/cli@latest and retry. In CI, remove an older cli-version pin or set it to 6.`,
    {
      reason: "CLI_UPGRADE_REQUIRED",
      minimumCliVersion: minimum,
      currentCliVersion: version,
    },
  );
}
