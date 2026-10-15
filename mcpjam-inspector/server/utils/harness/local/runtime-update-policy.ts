/**
 * Who may install a local runtime pack on this machine: the update policy.
 *
 *   auto    (default) — a missing or newer desired pack is fetched in the
 *           background: at server boot when this machine already holds a
 *           durable authorization for the harness, and from the Playground's
 *           readiness check. Sessions keep running on the permitted previous
 *           pack meanwhile.
 *   manual  — nothing is fetched on anyone's behalf, and the composer's
 *           "Install & allow" does not download either. Only
 *           `mcpjam-inspector harness install` and pre-provisioning
 *           (`harness install --from <archive>`) install. For fleets whose IT
 *           decides when bytes land on a machine.
 *
 * Set by an ADMINISTRATOR, in a managed configuration file a user's own
 * session does not write:
 *
 *   macOS    /Library/Application Support/MCPJam/managed.json
 *   Linux    /etc/mcpjam/managed.json
 *   Windows  %ProgramData%\MCPJam\managed.json
 *
 *   { "localHarness": { "updates": "manual" } }
 *
 * `MCPJAM_MANAGED_CONFIG` names another path (MDM tooling, tests). A file
 * that exists but cannot be read or parsed is treated as `manual`: somebody
 * meant to set a policy, and fetching 500 MB against an unreadable one is the
 * wrong way to fail.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../logger.js";

export type LocalRuntimeUpdatePolicy = "auto" | "manual";

export interface ResolvedUpdatePolicy {
  policy: LocalRuntimeUpdatePolicy;
  /** The file it came from, or null for the built-in default. */
  source: string | null;
  /** Set when a file existed and could not be used. */
  problem?: string;
}

/** The managed configuration file for this platform. */
export function managedConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.MCPJAM_MANAGED_CONFIG?.trim();
  if (override) return override;
  if (platform === "darwin") return "/Library/Application Support/MCPJam/managed.json";
  if (platform === "win32") {
    return join(env.ProgramData ?? env.PROGRAMDATA ?? "C:\\ProgramData", "MCPJam", "managed.json");
  }
  return "/etc/mcpjam/managed.json";
}

/** Parse a managed configuration document's update policy. */
export function parseUpdatePolicy(text: string): LocalRuntimeUpdatePolicy {
  const parsed = JSON.parse(text) as { localHarness?: { updates?: unknown } } | null;
  const value = parsed?.localHarness?.updates;
  if (value === undefined) return "auto";
  if (value === "auto" || value === "manual") return value;
  throw new Error(`localHarness.updates must be "auto" or "manual", not ${JSON.stringify(value)}`);
}

/** Read the policy. Never throws. */
export async function readLocalRuntimeUpdatePolicy(): Promise<ResolvedUpdatePolicy> {
  const path = managedConfigPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { policy: "auto", source: null };
    const problem = `the managed configuration at ${path} could not be read`;
    logger.warn(`[local-harness] ${problem}; treating runtime updates as manual`);
    return { policy: "manual", source: path, problem };
  }
  try {
    return { policy: parseUpdatePolicy(text), source: path };
  } catch (error) {
    const problem = `the managed configuration at ${path} is invalid: ${error instanceof Error ? error.message : String(error)}`;
    logger.warn(`[local-harness] ${problem}; treating runtime updates as manual`);
    return { policy: "manual", source: path, problem };
  }
}

/** What started an install. Only the first two run under `manual`. */
export type RuntimeInstallTrigger =
  | "cli"
  | "provision"
  | "gesture"
  | "readiness"
  | "boot";

/** May this trigger install under this policy? */
export function triggerAllowed(trigger: RuntimeInstallTrigger, policy: LocalRuntimeUpdatePolicy): boolean {
  return policy === "auto" || trigger === "cli" || trigger === "provision";
}

/** Background triggers — nobody is waiting on them, so they back off. */
export function isBackgroundTrigger(trigger: RuntimeInstallTrigger): boolean {
  return trigger === "boot" || trigger === "readiness";
}
