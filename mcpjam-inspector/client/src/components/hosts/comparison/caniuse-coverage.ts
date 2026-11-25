import type {
  HostComparisonSubject,
  HostConfigFieldDef,
} from "@/lib/host-config-field-schema";
import { getCaniuseSupportLevel } from "./caniuse-capability-catalog";
import { NOT_SUPPORTED } from "@/lib/host-config-field-schema";

const BASELINE = "preset:mcpjam";
const PROTOCOL = "supportedProtocolVersions";
const EVENTS = "eventsDeliveryModes";

export function capabilitySlices(
  field: HostConfigFieldDef,
  subjects: readonly HostComparisonSubject[],
) {
  if (field.kind.kind === "mode-set") return ["any", ...field.kind.modes];
  if (field.id !== PROTOCOL) return [];
  const versions = subjects.flatMap(({ config }) => {
    const value = field.read(config);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  });
  return [...new Set(versions)].sort().reverse();
}

export function sliceLabel(slice: string) {
  return slice === "any" ? "Any mode" : slice;
}

export function capabilityCoverage(
  field: HostConfigFieldDef,
  subjects: readonly HostComparisonSubject[],
  slice?: string,
) {
  const eventsMode = field.id === EVENTS ? slice || "any" : null;
  const reporting =
    field.id === "clientInfo.version" || field.id.startsWith("styles.");
  const rows = subjects
    .map((subject) => {
      const value = field.read(subject.config);
      const level = getCaniuseSupportLevel(field, subject.config);
      if (reporting)
        return {
          subject,
          status:
            value === NOT_SUPPORTED
              ? ("unsupported" as const)
              : value != null && value !== ""
                ? ("supported" as const)
                : ("unknown" as const),
        };
      if (
        field.id === PROTOCOL ||
        eventsMode !== null ||
        (field.kind.kind === "mode-set" && slice && slice !== "any")
      ) {
        const status = Array.isArray(value)
          ? (
              slice && slice !== "any"
                ? value.includes(slice)
                : value.length > 0
            )
            ? "supported"
            : "unsupported"
          : value === NOT_SUPPORTED
            ? "unsupported"
            : "unknown";
        return { subject, status } as const;
      }
      if (level === "unknown") return { subject, status: level };
      return {
        subject,
        status: level === "neutral" ? ("unsupported" as const) : level,
      };
    })
    .filter(({ subject }) => subject.hostId !== BASELINE);
  const full = rows.filter(({ status }) => status === "supported").length;
  const measured = reporting
    ? rows.length
    : rows.filter(({ status }) => status !== "unknown").length;
  return {
    rows,
    full,
    measured,
    reporting,
    eventsMode,
    score: measured ? Math.round((full / measured) * 100) : null,
  };
}

export type CapabilityCoverage = ReturnType<typeof capabilityCoverage>;

export function eventsSupportSummary({ full, measured, eventsMode }: CapabilityCoverage) {
  const mode = eventsMode === "any" ? "at least one delivery mode" : `${eventsMode} delivery`;
  return `${full} of ${measured} clients with published results support ${mode}.`;
}

export function caniuseTitle(field: HostConfigFieldDef) {
  if (field.id === PROTOCOL) return "Protocol versions";
  if (field.id === EVENTS) return "MCP Events";
  if (field.id === "capabilities.uiExtension") return "MCP Apps";
  return field.label;
}

export function publicClientIdentity(subject: HostComparisonSubject) {
  const id = subject.hostId.replace(/^preset:/, "");
  const family = id.startsWith("chatgpt")
    ? "chatgpt"
    : id.startsWith("claude-code")
      ? "claude-code"
      : id.startsWith("claude")
        ? "claude"
        : id.startsWith("codex")
          ? "codex"
          : id.startsWith("cursor")
            ? "cursor"
            : id;
  const cli = id.endsWith("-cli") || id === "claude-code" || id === "opencode";
  const desktop = id.includes("-desktop") || id === "goose";
  const web =
    !cli &&
    !desktop &&
    ["claude", "claude-code", "chatgpt", "codex", "gemini", "mistral"].includes(
      family,
    );
  const ide = ["cursor", "vscode", "cline", "copilot"].includes(id);
  const surface = cli
    ? "CLI"
    : desktop
      ? "Desktop"
      : web
        ? "Web"
        : ide
          ? "IDE"
          : "Apps & platforms";
  const mode =
    family === "chatgpt"
      ? id.includes("-work")
        ? "Work"
        : "Chat"
      : family === "claude-code"
        ? "Code"
        : family === "claude"
          ? "Chat"
          : "";
  return { surface, family, mode };
}

export function orderPublicClients(subjects: readonly HostComparisonSubject[]) {
  const order = ["Web", "Desktop", "IDE", "CLI", "Apps & platforms"];
  return [...subjects].sort((a, b) => {
    const first = publicClientIdentity(a),
      second = publicClientIdentity(b);
    return (
      order.indexOf(first.surface) - order.indexOf(second.surface) ||
      first.family.localeCompare(second.family) ||
      first.mode.localeCompare(second.mode)
    );
  });
}
