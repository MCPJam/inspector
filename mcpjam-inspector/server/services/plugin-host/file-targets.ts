import { admitLocalFileTargetContract } from "./local-file-target.js";
import { admitComputerFileTargetContract } from "./computer-file-target.js";
import { PluginFileTargetRefusal } from "./file-target-refusal.js";
import {
  describePluginError,
  pluginDiagnostic,
  type PluginDiagnostic,
} from "../../../shared/plugin-diagnostics.js";

export { PluginFileTargetRefusal } from "./file-target-refusal.js";

/** The client's `mcpProfile.extensions["mcpjam/plugin-file-targets"]`. */
export const PLUGIN_FILE_TARGETS_EXTENSION = "mcpjam/plugin-file-targets";
/** Operator allowlist for local installs (see the Inspector README). */
export const PLUGIN_LOCAL_FILE_ROOTS_ENV = "MCPJAM_PLUGIN_LOCAL_FILE_ROOTS";

/** Where an admitted file target's path lives. */
export type PluginFileTargetPlacement = "local" | "computer";

/** Why files can't be opened or written for this server. */
export type PluginFileTargetsUnavailableCode =
  | "PLUGIN_FILE_TARGETS_NOT_DECLARED"
  | "PLUGIN_LOCAL_FILES_NOT_CONFIGURED"
  | "PLUGIN_LOCAL_FILE_ROOTS_INVALID"
  | "PLUGIN_LOCAL_FILE_ROOT_NOT_ALLOWED"
  | "PLUGIN_FILES_COMPUTER_REQUIRED"
  | "PLUGIN_COMPUTER_FILE_ROOT_INVALID"
  | "PLUGIN_FILES_REMOTE_SERVER";

export interface PluginFileTargets {
  placement: PluginFileTargetPlacement;
  /** The admitted contract (only targets this request may use), if any. */
  contract?: unknown;
  /** Set when no target is usable for this server; explains why. */
  unavailable?: PluginFileTargetsUnavailableCode;
}

const declaredFor = (contract: unknown, serverId: string) => {
  if (!contract || typeof contract !== "object") return false;
  const targets = (contract as { targets?: unknown }).targets;
  return (
    Array.isArray(targets) &&
    targets.some(
      (target) =>
        !!target &&
        typeof target === "object" &&
        (target as { serverId?: unknown }).serverId === serverId,
    )
  );
};

/**
 * Admit this server's file targets for the request. Local installs read the
 * Inspector machine's own disk, so a target must also be allowed by the
 * operator in MCPJAM_PLUGIN_LOCAL_FILE_ROOTS: host JSON can select a file but
 * never grant filesystem access.
 */
export function pluginFileTargets(input: {
  contract: unknown;
  identity: { actorId: string; projectId: string; serverId: string };
  operatorRoots?: string | undefined;
  /** Hosted MCPJam: paths live on the project's Computer, never this host. */
  hosted?: boolean;
  /** The client has the project's Computer attached (`hostConfig.computer`). */
  computer?: boolean;
  /** The saved server's transport; hosted stdio servers run on the Computer. */
  transport?: string;
}): PluginFileTargets {
  const declared = declaredFor(input.contract, input.identity.serverId);
  if (input.hosted) {
    if (!declared)
      return {
        placement: "computer",
        unavailable: "PLUGIN_FILE_TARGETS_NOT_DECLARED",
      };
    // A remote server shares no disk with MCPJam or the Computer: its paths
    // point at a machine nobody here can reach.
    if (input.transport !== "stdio")
      return { placement: "computer", unavailable: "PLUGIN_FILES_REMOTE_SERVER" };
    if (!input.computer)
      return {
        placement: "computer",
        unavailable: "PLUGIN_FILES_COMPUTER_REQUIRED",
      };
    const contract = admitComputerFileTargetContract(
      input.contract,
      input.identity.serverId,
    );
    return contract
      ? { placement: "computer", contract }
      : {
          placement: "computer",
          unavailable: "PLUGIN_COMPUTER_FILE_ROOT_INVALID",
        };
  }
  const roots = input.operatorRoots?.trim();
  if (!roots)
    return {
      placement: "local",
      unavailable: declared
        ? "PLUGIN_LOCAL_FILES_NOT_CONFIGURED"
        : "PLUGIN_FILE_TARGETS_NOT_DECLARED",
    };
  try {
    JSON.parse(roots);
  } catch {
    return { placement: "local", unavailable: "PLUGIN_LOCAL_FILE_ROOTS_INVALID" };
  }
  const contract = admitLocalFileTargetContract(
    input.contract,
    input.identity,
    roots,
  );
  if (contract) return { placement: "local", contract };
  return {
    placement: "local",
    unavailable: declared
      ? "PLUGIN_LOCAL_FILE_ROOT_NOT_ALLOWED"
      : "PLUGIN_FILE_TARGETS_NOT_DECLARED",
  };
}

/** The allowlist entry an operator would add for this actor and server. */
const operatorEntry = (identity: {
  actorId: string;
  projectId: string;
  serverId: string;
}) => ({
  env: PLUGIN_LOCAL_FILE_ROOTS_ENV,
  entry: { ...identity, root: "<absolute folder>" },
});

/** Refuse a local-file open with what's missing and how to fix it. */
export function refusePluginFileOpen(
  targets: PluginFileTargets,
  identity: { actorId: string; projectId: string; serverId: string },
): never {
  const code = targets.unavailable ?? "PLUGIN_LOCAL_FILE_NOT_LISTED";
  throw new PluginFileTargetRefusal(
    code,
    identity.serverId,
    "Couldn't open a local file",
    code === "PLUGIN_LOCAL_FILES_NOT_CONFIGURED" ||
      code === "PLUGIN_LOCAL_FILE_ROOT_NOT_ALLOWED"
      ? operatorEntry(identity)
      : code === "PLUGIN_LOCAL_FILE_NOT_LISTED" ||
          code === "PLUGIN_FILE_TARGETS_NOT_DECLARED"
        ? { extension: PLUGIN_FILE_TARGETS_EXTENSION }
        : undefined,
  );
}

/** A warning for an App opened on a declared file target that can't be used:
 * the file still opens read-only through the server, but saves are off. */
export function pluginFileTargetsWarning(
  targets: PluginFileTargets,
  serverId: string,
): PluginDiagnostic[] {
  if (
    !targets.unavailable ||
    targets.unavailable === "PLUGIN_FILE_TARGETS_NOT_DECLARED"
  )
    return [];
  return [
    {
      ...pluginDiagnostic(
        "warning",
        targets.unavailable,
        "File targets unavailable: files open read-only",
        describePluginError(targets.unavailable) ?? targets.unavailable,
      ),
      serverId,
    },
  ];
}
