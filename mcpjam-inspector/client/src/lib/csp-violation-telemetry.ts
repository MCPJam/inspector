import type { CspViolation } from "@/stores/widget-debug-store";
import type { CspApplicationIntent } from "@mcpjam/widget-react";
import type { CspPolicyComparison } from "@/components/chat-v2/thread/csp-workbench/csp-header";
import {
  parseCspHeader,
  resolveDirective,
} from "@/components/chat-v2/thread/csp-workbench/csp-header";
import { captureSentryMessage } from "./sentry";

const MAX_POLICY_LENGTH = 16_000;
const REDACTED_SOURCE_RE = /^'?(nonce|sha256|sha384|sha512)-/i;

function parentDirective(directive: string): string {
  const normalized = directive.toLowerCase();
  if (normalized === "script-src-elem" || normalized === "script-src-attr") {
    return "script-src";
  }
  if (normalized === "style-src-elem" || normalized === "style-src-attr") {
    return "style-src";
  }
  return normalized;
}

function intendedSources(
  intent: CspApplicationIntent,
  directive: string,
): string[] {
  const normalized = parentDirective(directive);
  const sources = new Set<string>();
  const csp = intent.csp;
  if (normalized === "connect-src") {
    csp?.connectDomains?.forEach((source) => sources.add(source));
  } else if (normalized === "frame-src") {
    csp?.frameDomains?.forEach((source) => sources.add(source));
  } else if (normalized === "base-uri") {
    csp?.baseUriDomains?.forEach((source) => sources.add(source));
  } else if (
    normalized === "script-src" ||
    normalized === "style-src" ||
    normalized === "img-src" ||
    normalized === "font-src" ||
    normalized === "media-src"
  ) {
    csp?.resourceDomains?.forEach((source) => sources.add(source));
  }
  intent.cspDirectives?.[normalized]?.forEach((source) => sources.add(source));
  intent.cspDirectives?.[directive.toLowerCase()]?.forEach((source) =>
    sources.add(source),
  );
  return [...sources];
}

/**
 * Conservative allow check for paging. Path-scoped and ambiguous expressions
 * intentionally return false: missing a page is safer than waking someone for
 * a policy the app itself configured incorrectly.
 */
function clearlyAllowsUrl(value: string, sources: readonly string[]): boolean {
  let blocked: URL;
  try {
    blocked = new URL(value);
  } catch {
    return false;
  }

  return sources.some((source) => {
    const trimmed = source.trim();
    if (trimmed === "*") return true;
    if (trimmed === `${blocked.protocol}`) return true;
    if (trimmed.startsWith("'")) return false;

    try {
      const allowed = new URL(trimmed);
      if (allowed.pathname !== "/" || allowed.search || allowed.hash) {
        return false;
      }
      if (allowed.protocol !== blocked.protocol) return false;
      if (allowed.port && allowed.port !== blocked.port) return false;
      if (allowed.hostname.startsWith("*.")) {
        const suffix = allowed.hostname.slice(1).toLowerCase();
        return blocked.hostname.toLowerCase().endsWith(suffix);
      }
      return allowed.origin === blocked.origin;
    } catch {
      return false;
    }
  });
}

function hasAmbiguousUrlSource(sources: readonly string[]): boolean {
  return sources.some((source) => {
    const trimmed = source.trim();
    if (
      trimmed === "*" ||
      trimmed === "'none'" ||
      /^[a-zA-Z][a-zA-Z0-9+.-]*:$/.test(trimmed)
    ) {
      return false;
    }
    if (trimmed.startsWith("'")) return true;
    try {
      const parsed = new URL(trimmed);
      return parsed.pathname !== "/" || Boolean(parsed.search || parsed.hash);
    } catch {
      return true;
    }
  });
}

export function failedToApplyCsp(args: {
  violation: CspViolation;
  appliedPolicy?: string;
  intent?: CspApplicationIntent;
}): boolean {
  const { violation, appliedPolicy, intent } = args;
  if (!intent || !appliedPolicy || violation.disposition !== "enforce") {
    return false;
  }
  const directive = parentDirective(
    violation.effectiveDirective || violation.directive,
  );
  const intendedAllows =
    intent.permissive ||
    clearlyAllowsUrl(violation.blockedUri, intendedSources(intent, directive));
  if (!intendedAllows) return false;

  const appliedSources = resolveDirective(
    parseCspHeader(appliedPolicy),
    directive,
  );
  if (hasAmbiguousUrlSource(appliedSources ?? [])) return false;
  return !clearlyAllowsUrl(violation.blockedUri, appliedSources ?? []);
}

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
  intent?: CspApplicationIntent;
  comparison: CspPolicyComparison;
}): void {
  const { toolCallId, serverId, violation, comparison } = args;
  const directive = violation.effectiveDirective || violation.directive;
  const applied = sanitizeCspPolicy(args.appliedPolicy);
  const original = sanitizeCspPolicy(violation.originalPolicy);
  const blockedUrl = sanitizeUrl(violation.blockedUri);
  const applyFailed = failedToApplyCsp({
    violation,
    appliedPolicy: args.appliedPolicy,
    intent: args.intent,
  });
  const intentSources = args.intent
    ? intendedSources(args.intent, directive).map(
        (source) => sanitizeUrl(source) ?? source,
      )
    : undefined;

  try {
    captureSentryMessage(
      applyFailed ? "Failed to apply CSP" : "MCP App CSP violation",
      {
        level: applyFailed ? "error" : "warning",
        fingerprint: [
          applyFailed ? "failed-to-apply-csp" : "mcp-app-csp-violation",
          directive,
        ],
        tags: {
          csp_directive: directive,
          csp_disposition: violation.disposition ?? "unknown",
          csp_policy_comparison: comparison.status,
          csp_mode: args.appliedMode ?? "unknown",
          mcpjam_csp_apply_failed: applyFailed ? "true" : "false",
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
          intendedSources: intentSources,
        },
      },
    );
  } catch {
    // Telemetry must never affect widget rendering.
  }
}
