/**
 * The saved settings a hosted conformance run starts with.
 *
 * A start on a saved server runs what the app runs for it: the checks and
 * advice its settings pick, and the tool inputs those checks call, at the
 * protocol version the run resolves to. `settings: "none"` opts out and runs
 * every check with no tool inputs. Tool inputs kept only in a browser (the
 * per-check Tasks tools and the log level advice's own tool) have no hosted
 * equivalent and are not part of a hosted run.
 */
import type { ConvexHttpClient } from "convex/browser";
import type { HttpServerConfig, McpProtocolVersion } from "@mcpjam/sdk";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import { checkConformanceConnection } from "../routes/shared/conformance-connection.js";
import { DEFAULT_CONFORMANCE_RUN_TIMEOUT_SECONDS } from "../../shared/conformance-timeout.js";
import {
  conformanceSuiteConfigs,
  decodeStoredProbes,
  isSelected,
  runnableSelection,
  storedSelection,
  type ConformanceProbes,
  type ConformanceSelection,
  type StoredConformanceProbes,
  type StoredConformanceSettings,
} from "../../shared/conformance-settings.js";

/** What the caller asked for: the server's saved settings, or none. */
export type ConformanceSettingsMode = "saved" | "none";

/**
 * What the run used: the server's saved settings, the defaults of a server
 * with none saved (every check, no tool inputs), or none because the caller
 * opted out.
 */
export type ConformanceSettingsSource = "saved" | "defaults" | "none";

export interface ConformanceRunSettings {
  source: ConformanceSettingsSource;
  /** Absent: every check of every suite. */
  selection?: ConformanceSelection;
  probes: ConformanceProbes;
  runTimeoutSeconds: number;
}

type StoredSettingsRow = StoredConformanceSettings & {
  runTimeoutSeconds?: number;
  defaultInputs?: StoredConformanceProbes;
};

const UNREADABLE_INPUTS =
  'The saved tool inputs for this server could not be read. Save them again on the Conformance page, or start the run with settings set to "none".';

export async function readConformanceRunSettings(
  client: Pick<ConvexHttpClient, "query">,
  args: { projectId: string; serverId: string; mode: ConformanceSettingsMode },
): Promise<ConformanceRunSettings> {
  const unsaved = (source: ConformanceSettingsSource) => ({
    source,
    probes: {},
    runTimeoutSeconds: DEFAULT_CONFORMANCE_RUN_TIMEOUT_SECONDS,
  });
  if (args.mode === "none") return unsaved("none");
  const row = (await client.query(
    "conformanceSettings:getServerSettings" as never,
    { projectId: args.projectId, serverId: args.serverId } as never,
  )) as StoredSettingsRow | null;
  if (!row) return unsaved("defaults");
  const probes = decodeStoredProbes(row.defaultInputs);
  if (probes instanceof Error) {
    throw new WebRouteError(409, ErrorCode.CONFLICT, UNREADABLE_INPUTS);
  }
  return {
    source: "saved",
    selection: storedSelection(row),
    probes,
    runTimeoutSeconds:
      row.runTimeoutSeconds ?? DEFAULT_CONFORMANCE_RUN_TIMEOUT_SECONDS,
  };
}

/**
 * The requested suites the settings keep, in the order requested. As in the
 * app, a suite the settings leave out is neither run nor recorded.
 */
export function suitesKeptBySettings<
  Suite extends "protocol" | "apps" | "tasks",
>(
  requested: readonly Suite[],
  settings: ConformanceRunSettings,
  protocolVersion: McpProtocolVersion | undefined,
): Suite[] {
  const picked = runnableSelection(
    settings.selection,
    protocolVersion ?? "auto",
  );
  return requested.filter((suite) => isSelected(picked?.[suite]));
}

/**
 * Each suite's SDK config for a run with these settings, the version the run
 * is pinned to, and what the settings select at that version. Saved settings
 * resolve the version first, as the app does before Run, because which checks
 * run and which tools they call depend on it. A connection that does not
 * resolve leaves the version as requested, and the run reports that failure
 * itself.
 */
export async function suiteConfigsForRun(
  settings: ConformanceRunSettings,
  server: HttpServerConfig,
  protocolVersion: McpProtocolVersion | undefined,
  signal: AbortSignal,
) {
  if (settings.source !== "saved") return { protocolVersion };
  const connection = await checkConformanceConnection(
    server,
    protocolVersion ?? "auto",
    { signal },
  );
  const pin =
    connection.status === "ready"
      ? connection.protocolVersion
      : protocolVersion;
  const configs = conformanceSuiteConfigs(
    { selection: settings.selection, probes: settings.probes },
    pin ?? "auto",
  );
  return {
    protocolVersion: pin,
    selection: configs.selection,
    protocol: configs.protocol,
    apps: configs.apps,
    tasks: configs.tasks,
  };
}
