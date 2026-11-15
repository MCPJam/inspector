/**
 * The IT settings file: a file an administrator installs to set, and
 * optionally lock, the MCPJam server for every CLI command and SDK Node entry
 * point on the machine.
 *
 *   { "version": 1, "apiUrl": "https://mcpjam.acme.com/api/v1", "lock": true }
 *
 * It is read from one fixed path per platform, in a folder standard users
 * cannot write to. No environment variable can point at a different file,
 * because an override would be a one-line way around the lock. The reader is
 * strict and fails closed: a file it cannot enforce exactly is invalid, and an
 * invalid file stops everything that would contact MCPJam.
 */
import { readFileSync } from "node:fs";
import { isLoopbackHost } from "../oauth/state-machines/shared/client-id-metadata.js";
import { tryParseApiUrl, type DeploymentAddress } from "./address.js";

const SYSTEM_PATHS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/Library/Application Support/MCPJam/managed-settings.json",
  win32: "C:\\Program Files\\MCPJam\\managed-settings.json",
};
const POSIX_PATH = "/etc/mcpjam/managed-settings.json";

/**
 * Tests point the reader at their own file through this registered global,
 * set in-process or by a preload. Anything able to inject a preload can
 * already patch the CLI, so this opens no new way around the lock.
 */
const PATH_SEAM = Symbol.for("mcpjam.managedSettingsPath");

const KEYS = new Set(["version", "apiUrl", "lock"]);

export type ManagedSettings =
  | { state: "absent" }
  | {
      state: "valid";
      path: string;
      deployment: DeploymentAddress;
      lock: boolean;
    }
  | { state: "invalid"; path: string; problem: string };

export function managedSettingsPath(
  platform: NodeJS.Platform = process.platform
): string {
  const seam: unknown = Reflect.get(globalThis, PATH_SEAM);
  if (typeof seam === "string") return seam;
  return SYSTEM_PATHS[platform] ?? POSIX_PATH;
}

function invalid(path: string, problem: string): ManagedSettings {
  return { state: "invalid", path, problem };
}

/** The `problem` sentence for a file that is not exactly what IT intended. */
function check(path: string, parsed: unknown): ManagedSettings {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid(path, "is not a JSON object");
  }
  const unknown = Object.keys(parsed).find((key) => !KEYS.has(key));
  if (unknown !== undefined) {
    return invalid(path, `has a setting this CLI does not know: "${unknown}"`);
  }
  const record: Record<string, unknown> = { ...parsed };
  if (record.version !== 1) {
    return invalid(path, `needs "version": 1`);
  }
  if (typeof record.apiUrl !== "string") {
    return invalid(path, `needs "apiUrl" as a string`);
  }
  if (typeof record.lock !== "boolean") {
    return invalid(path, `needs "lock" set to true or false`);
  }
  const deployment = tryParseApiUrl(record.apiUrl);
  if (!deployment) {
    return invalid(
      path,
      `needs "apiUrl" as a full http(s) URL with no credentials, query or fragment`
    );
  }
  const url = new URL(deployment.apiUrl);
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    return invalid(
      path,
      `has an "apiUrl" that is not https:// (plain http:// is allowed only for a loopback address)`
    );
  }
  return { state: "valid", path, deployment, lock: record.lock };
}

/** Reads the file fresh on every call: it is small, and IT may replace it. */
export function readManagedSettings(): ManagedSettings {
  const path = managedSettingsPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
    // Present but unreadable: the intended policy is unknown, so fail closed.
    return invalid(path, `could not be read (${code ?? "unknown error"})`);
  }
  // PowerShell 5.1's `Set-Content -Encoding UTF8` and `Out-File` write a
  // UTF-8 byte-order mark, which `JSON.parse` rejects.
  const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return invalid(path, "is not valid JSON");
  }
  return check(path, parsed);
}

/**
 * What MCPJam's own telemetry and update check may do. A lock turns them off;
 * so does an invalid file, because the policy IT intended is unknown.
 */
export function deploymentPolicy(): { locked: boolean; invalid?: string } {
  const settings = readManagedSettings();
  if (settings.state === "invalid") {
    return { locked: false, invalid: managedSettingsProblem(settings) };
  }
  return { locked: settings.state === "valid" && settings.lock };
}

export function managedSettingsProblem(
  settings: Extract<ManagedSettings, { state: "invalid" }>
): string {
  return `The MCPJam settings file installed by your organization (${settings.path}) ${settings.problem}. Until an administrator fixes it, commands that contact MCPJam stop before sending anything.`;
}
