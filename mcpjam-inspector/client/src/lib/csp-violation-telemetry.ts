import type { CspViolation } from "@/stores/widget-debug-store";
import type { CspPolicyComparison } from "@/components/chat-v2/thread/csp-workbench/csp-header";
import { captureSentryMessage } from "./sentry";

const MAX_POLICY_LENGTH = 16_000;
const REDACTED_SOURCE_RE = /^'?(nonce|sha256|sha384|sha512)-/i;

function sanitizeUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

function sanitizedOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function sanitizeCspPolicy(
  policy: string | undefined,
): { value: string; truncated: boolean } | undefined {
  if (!policy) return undefined;
  const sanitized = policy
    .split(/(\s+|;)/)
    .map((token) => {
      if (REDACTED_SOURCE_RE.test(token)) {
        const quoted = token.startsWith("'");
        const start = quoted ? 1 : 0;
        const kind = token.slice(start, token.indexOf("-")).toLowerCase();
        return `${quoted ? "'" : ""}${kind}-[redacted]${quoted ? "'" : ""}`;
      }
      return sanitizeUrl(token) ?? token;
    })
    .join("");
  return {
    value: sanitized.slice(0, MAX_POLICY_LENGTH),
    truncated: sanitized.length > MAX_POLICY_LENGTH,
  };
}

export class CspViolationTelemetryLimiter {
  private readonly seen = new Map<string, Set<string>>();

  constructor(private readonly limitPerMount = 10) {}

  shouldReport(
    toolCallId: string,
    serverId: string,
    violation: CspViolation,
  ): boolean {
    const mountKey = `${serverId}:${toolCallId}:${
      violation.mountId ?? "legacy"
    }`;
    const entries = this.seen.get(mountKey) ?? new Set<string>();
    const signature = [
      violation.effectiveDirective || violation.directive,
      violation.blockedUri,
      violation.sourceFile ?? "",
      violation.lineNumber ?? "",
      violation.columnNumber ?? "",
      violation.originalPolicy ?? "",
    ].join("|");
    if (entries.has(signature) || entries.size >= this.limitPerMount)
      return false;
    entries.add(signature);
    this.seen.set(mountKey, entries);
    return true;
  }

  clearToolCall(toolCallId: string): void {
    for (const key of this.seen.keys()) {
      if (key.includes(`:${toolCallId}:`)) this.seen.delete(key);
    }
  }
}

export function reportCspViolationToSentry(args: {
  toolCallId: string;
  serverId: string;
  violation: CspViolation;
  appliedPolicy?: string;
  appliedMode?: "permissive" | "widget-declared";
  comparison: CspPolicyComparison;
}): void {
  const { toolCallId, serverId, violation, comparison } = args;
  const directive = violation.effectiveDirective || violation.directive;
  const applied = sanitizeCspPolicy(args.appliedPolicy);
  const original = sanitizeCspPolicy(violation.originalPolicy);
  const blockedUrl = sanitizeUrl(violation.blockedUri);

  try {
    captureSentryMessage("MCP App CSP violation", {
      level: "warning",
      fingerprint: ["mcp-app-csp-violation", directive],
      tags: {
        csp_directive: directive,
        csp_disposition: violation.disposition ?? "unknown",
        csp_policy_comparison: comparison.status,
        csp_mode: args.appliedMode ?? "unknown",
      },
      extra: {
        mountId: violation.mountId,
        serverId,
        toolCallId,
        blockedOrigin: sanitizedOrigin(violation.blockedUri),
        blockedUrl,
        sourceFile: sanitizeUrl(violation.sourceFile),
        lineNumber: violation.lineNumber,
        columnNumber: violation.columnNumber,
        appliedPolicy: applied?.value,
        appliedPolicyTruncated: applied?.truncated,
        originalPolicy: original?.value,
        originalPolicyTruncated: original?.truncated,
        differingDirectives: comparison.differingDirectives,
      },
    });
  } catch {
    // Telemetry must never affect widget rendering.
  }
}
