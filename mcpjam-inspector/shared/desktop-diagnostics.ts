/** Internal, allowlisted telemetry; never accepts callback URLs or error messages. */
export const DESKTOP_DIAGNOSTICS_CHANNEL = "desktop:diagnostic";
export const DIAGNOSTIC_KINDS = [
  "connect",
  "reconnect",
  "oauth_callback",
  "oauth_authorize",
  "token_import",
  "auth",
  "renderer",
] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];
export type DesktopActivity = {
  kind: DiagnosticKind;
  phase: "start" | "success" | "failure" | "state";
  operationId?: string;
  auth?: "loading" | "signed_in" | "guest";
  status?: number;
  error?: "network" | "timeout" | "access_denied" | "not_found" | "other";
  version?: string;
};

export function parseDesktopActivity(value: unknown): DesktopActivity | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    !DIAGNOSTIC_KINDS.includes(v.kind as DiagnosticKind) ||
    !["start", "success", "failure", "state"].includes(v.phase as string)
  )
    return null;
  const out: DesktopActivity = {
    kind: v.kind as DiagnosticKind,
    phase: v.phase as DesktopActivity["phase"],
  };
  if (v.operationId !== undefined) {
    if (
      typeof v.operationId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(v.operationId)
    )
      return null;
    out.operationId = v.operationId;
  }
  if (v.auth !== undefined) {
    if (!["loading", "signed_in", "guest"].includes(v.auth as string))
      return null;
    out.auth = v.auth as DesktopActivity["auth"];
  }
  if (v.status !== undefined) {
    if (
      !Number.isInteger(v.status) ||
      (v.status as number) < 100 ||
      (v.status as number) > 599
    )
      return null;
    out.status = v.status as number;
  }
  if (v.error !== undefined) {
    if (
      !["network", "timeout", "access_denied", "not_found", "other"].includes(
        v.error as string,
      )
    )
      return null;
    out.error = v.error as DesktopActivity["error"];
  }
  if (v.version !== undefined) {
    if (
      typeof v.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,40})?$/.test(v.version)
    )
      return null;
    out.version = v.version;
  }
  return out;
}
