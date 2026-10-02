/**
 * Lazy authentication ("mid-session sign-in"): the gate, the evidence shape,
 * and the pure reasoning shared by both publishers.
 *
 * WHAT LAZY AUTHENTICATION IS. A server lets a client `initialize`, list its
 * tools and call its public tools with no credentials, and refuses only the
 * calls that need a signed-in user. Nothing about that is visible from an
 * unauthenticated `initialize`: the server answers it, which is exactly what an
 * authless server does. The only observation that tells them apart is a
 * PROTECTED CALL made without credentials, and how it is refused.
 *
 * HOSTS DISAGREE ABOUT THE REFUSAL, and the probe records what the server sent
 * rather than deciding for a host. Claude starts sign-in only when the request
 * itself fails with HTTP 401 and a `WWW-Authenticate` header; OpenAI's
 * tool-level flow reads `_meta["mcp/www_authenticate"]` on an `isError` tool
 * result, for a tool whose `securitySchemes` include `oauth2`. The refusal is
 * parsed once, by the shared `auth-challenge` module, and each publisher's
 * checks apply their own host's rule to the parsed facets.
 *
 * THE GATE. The probe calls tools on somebody else's server, so it runs only
 * when a caller explicitly arms it, and then within fixed bounds:
 *
 *   - `enabled: true` as a literal boolean;
 *   - no credentials on any request it makes, ever;
 *   - only tools annotated `readOnlyHint: true`;
 *   - at most two `tools/call` requests: one public, one protected.
 *
 * It is a separate opt-in from the intrusive probes, which spend grants and
 * register clients. This one spends nothing and holds no credential, which is
 * why a hosted run may offer it while it refuses intrusive probes outright.
 *
 * Pure data and data reasoning. No transport. Safe from the browser entry.
 */

import {
  hasOAuth2Scheme,
  resolveToolSecuritySchemes,
  type AuthChallengeSignal,
  type AuthChallengeSource,
  type ToolSecuritySchemeResolution,
} from "../mcp-client-manager/auth-challenge.js";

// ── Claims ──────────────────────────────────────────────────────────────

/**
 * Features a submitter may CLAIM. A claim unlocks depth evaluation and is
 * reported as `claimed`; it is never itself evidence.
 */
export const DIRECTORY_FEATURE_CLAIMS = [
  "lazy-authentication",
  "enterprise-managed-auth",
] as const;

export type DirectoryFeatureClaim = (typeof DIRECTORY_FEATURE_CLAIMS)[number];

/** Bounds every surface validates against, stated once. */
export const LAZY_AUTH_PROBE_LIMITS = Object.freeze({
  /** A tool name a caller may hand the probe. */
  toolNameMaxChars: 128,
  /** Feature claims on one run. */
  maxFeatureClaims: 10,
  /** `tools/call` requests one probe may make. */
  maxToolCalls: 2,
});

export function isDirectoryFeatureClaim(
  value: unknown,
): value is DirectoryFeatureClaim {
  return (
    typeof value === "string" &&
    (DIRECTORY_FEATURE_CLAIMS as readonly string[]).includes(value)
  );
}

/**
 * Read a claim list off an untrusted value.
 *
 * Unknown entries are RETURNED, not dropped silently, so a surface can refuse
 * a typo rather than let `lazy-auth` read as "nothing claimed".
 */
export function normalizeFeatureClaims(value: unknown): {
  claims: DirectoryFeatureClaim[];
  unknown: string[];
} {
  const claims = new Set<DirectoryFeatureClaim>();
  const unknown: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, LAZY_AUTH_PROBE_LIMITS.maxFeatureClaims)) {
      const trimmed = typeof entry === "string" ? entry.trim() : entry;
      if (isDirectoryFeatureClaim(trimmed)) claims.add(trimmed);
      else unknown.push(String(entry).slice(0, 64));
    }
  }
  return { claims: [...claims].sort(), unknown };
}

// ── The gate ────────────────────────────────────────────────────────────

/** What a caller asks for. */
export interface DirectoryLazyAuthProbeConfig {
  /** Literal `true`. A truthy value of any other type is refused. */
  enabled: boolean;
  /**
   * The protected tool to call without credentials. When absent, the probe
   * picks a read-only tool whose `securitySchemes` declare `oauth2` and not
   * `noauth`.
   */
  toolName?: string;
  /**
   * The public tool to call without credentials. When absent, the probe
   * picks a read-only tool whose `securitySchemes` declare `noauth`.
   */
  publicToolName?: string;
}

export type DirectoryLazyAuthProbeMode =
  | { enabled: false; reason: string }
  | { enabled: true; toolName?: string; publicToolName?: string };

function readToolName(
  value: unknown,
  label: string,
): { ok: true; name?: string } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, reason: `${label} must be a non-empty string` };
  }
  const name = value.trim();
  if (name.length > LAZY_AUTH_PROBE_LIMITS.toolNameMaxChars) {
    return {
      ok: false,
      reason: `${label} is longer than ${LAZY_AUTH_PROBE_LIMITS.toolNameMaxChars} characters`,
    };
  }
  return { ok: true, name };
}

/**
 * The one door in. Returns a disabled mode with a reason for anything short of
 * a complete, explicit opt-in. `undefined` is the ordinary case and means off.
 */
export function resolveLazyAuthProbeMode(
  config: unknown,
): DirectoryLazyAuthProbeMode {
  if (config === undefined || config === null) {
    return { enabled: false, reason: "the lazy-auth probe was not requested" };
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    return { enabled: false, reason: "the lazy-auth probe config is not an object" };
  }
  const record = config as Record<string, unknown>;
  // A literal boolean, not a truthy value: `"false"` from a query string must
  // not make a run call tools on somebody else's server.
  if (record.enabled !== true) {
    return {
      enabled: false,
      reason:
        "the lazy-auth probe requires `enabled: true` as a boolean; any other value is treated as off",
    };
  }
  const tool = readToolName(record.toolName, "toolName");
  if (!tool.ok) return { enabled: false, reason: tool.reason };
  const publicTool = readToolName(record.publicToolName, "publicToolName");
  if (!publicTool.ok) return { enabled: false, reason: publicTool.reason };
  if (tool.name !== undefined && tool.name === publicTool.name) {
    return {
      enabled: false,
      reason:
        "toolName and publicToolName name the same tool; one call cannot be both the public and the protected one",
    };
  }
  return {
    enabled: true,
    ...(tool.name !== undefined ? { toolName: tool.name } : {}),
    ...(publicTool.name !== undefined
      ? { publicToolName: publicTool.name }
      : {}),
  };
}

// ── Evidence ────────────────────────────────────────────────────────────

/** How one unauthenticated `tools/call` was answered. */
export type DirectoryLazyAuthCallOutcome =
  /** A 2xx tool result with `isError` not set. */
  | "succeeded"
  /** A 2xx tool result with `isError: true`, with or without a `_meta` challenge. */
  | "tool-error"
  /** HTTP 401. */
  | "unauthorized"
  /** HTTP 403. */
  | "forbidden"
  /** Any other non-2xx status. */
  | "http-error"
  /** A JSON-RPC error instead of a result. */
  | "rpc-error"
  /** Nothing readable answered. A gap in this run, not a fact about the server. */
  | "unreachable";

/** One tool the probe called, and how the call went. */
export interface DirectoryLazyAuthToolCall {
  toolName: string;
  /** `named` when the caller chose it; otherwise read off `securitySchemes`. */
  selectedBy: "named" | "security-schemes";
  /** The tool's resolved schemes. `unresolved` is never "no OAuth". */
  schemes: ToolSecuritySchemeResolution;
  outcome: DirectoryLazyAuthCallOutcome;
  status?: number;
  /**
   * The refusal, parsed once by the shared challenge parser: the HTTP
   * `WWW-Authenticate` on a 401/403, or `_meta["mcp/www_authenticate"]` on an
   * `isError` result. Absent when the server sent neither.
   */
  challenge?: AuthChallengeSignal;
  error?: string;
}

/** Metadata discovery re-run from the protected call's challenge. */
export interface DirectoryLazyAuthRediscovery {
  /** Where the PRM pointer came from. */
  trigger: "resource_metadata" | "well-known-fallback";
  /** Which kind of challenge set it off. */
  source: AuthChallengeSource;
  /** Whether the re-run found a Protected Resource Metadata document. */
  prmFound: boolean;
  prmUrl?: string;
  discoveredVia?: string;
}

export interface DirectoryLazyAuthProbeEvidence {
  /** False when the probe was requested and the gate refused it. */
  attempted: boolean;
  /** Why it did not run, or stopped before a call. */
  reason?: string;
  /**
   * The protocol revision the probe's session negotiated: the dial's pinned
   * one. The grade is a statement about that era only.
   */
  protocolVersion: string;
  /** The era caveat, stated with the evidence so no reader has to infer it. */
  eraNote: string;
  /** The probe's own anonymous `initialize`. */
  initialize?: {
    ok: boolean;
    status?: number;
    /** A refusal's challenge, parsed once. */
    challenge?: AuthChallengeSignal;
    unreachable?: boolean;
    error?: string;
  };
  /** What an anonymous session could list. */
  anonymousToolListing?: {
    complete: boolean;
    toolCount: number;
    error?: string;
  };
  publicCall?: DirectoryLazyAuthToolCall;
  /** Why no public call was made. */
  publicCallSkipped?: string;
  protectedCall?: DirectoryLazyAuthToolCall;
  /** Why no protected call was made. */
  protectedCallSkipped?: string;
  /** Set when the protected call's challenge sent discovery round again. */
  rediscovery?: DirectoryLazyAuthRediscovery;
}

/** The sentence every probe result carries about the era it graded. */
export function lazyAuthEraNote(protocolVersion: string): string {
  return `The probe opened its own unauthenticated session at protocol ${protocolVersion}, so it grades the session-based (pre-2026) era only; a server whose behavior differs in a later revision is not graded here.`;
}

/** Evidence for a probe the gate refused. */
export function refusedLazyAuthProbe(
  reason: string,
  protocolVersion: string,
): DirectoryLazyAuthProbeEvidence {
  return {
    attempted: false,
    reason,
    protocolVersion,
    eraNote: lazyAuthEraNote(protocolVersion),
  };
}

// ── Tool selection ──────────────────────────────────────────────────────

/** The fields of a listed tool the selection reads. */
export interface LazyAuthCandidateTool {
  name: string;
  annotations?: Record<string, unknown>;
  securitySchemes?: unknown;
  _meta?: Record<string, unknown>;
}

export interface LazyAuthToolSelection<Tool extends LazyAuthCandidateTool> {
  publicTool?: {
    tool: Tool;
    selectedBy: DirectoryLazyAuthToolCall["selectedBy"];
    schemes: ToolSecuritySchemeResolution;
  };
  publicSkipped?: string;
  protectedTool?: {
    tool: Tool;
    selectedBy: DirectoryLazyAuthToolCall["selectedBy"];
    schemes: ToolSecuritySchemeResolution;
  };
  protectedSkipped?: string;
}

function schemesOf(tool: LazyAuthCandidateTool): ToolSecuritySchemeResolution {
  return resolveToolSecuritySchemes({
    declaration: { securitySchemes: tool.securitySchemes, _meta: tool._meta },
  });
}

function hasScheme(
  resolution: ToolSecuritySchemeResolution,
  type: string,
): boolean {
  return resolution.schemes.some((scheme) => scheme.type === type);
}

function isReadOnly(tool: LazyAuthCandidateTool): boolean {
  return tool.annotations?.readOnlyHint === true;
}

/**
 * Choose at most one public and one protected tool.
 *
 * READ-ONLY OR NOTHING. A named tool that is not annotated
 * `readOnlyHint: true` is refused with a reason rather than called: the probe
 * cannot know what an unannotated tool does, and finding out by calling it is
 * how a readiness run changes someone's data.
 */
export function selectLazyAuthProbeTools<Tool extends LazyAuthCandidateTool>(
  mode: Extract<DirectoryLazyAuthProbeMode, { enabled: true }>,
  tools: readonly Tool[],
): LazyAuthToolSelection<Tool> {
  const selection: LazyAuthToolSelection<Tool> = {};

  const named = (
    name: string,
    role: "public" | "protected",
  ): { tool?: Tool; skipped?: string } => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return {
        skipped: `no tool named "${name}" was listed, so the ${role} call was not made`,
      };
    }
    if (!isReadOnly(tool)) {
      return {
        skipped: `"${name}" is not annotated readOnlyHint: true; the probe calls read-only tools only, so the ${role} call was not made`,
      };
    }
    return { tool };
  };

  // ── public ──
  if (mode.publicToolName !== undefined) {
    const picked = named(mode.publicToolName, "public");
    if (picked.tool) {
      selection.publicTool = {
        tool: picked.tool,
        selectedBy: "named",
        schemes: schemesOf(picked.tool),
      };
    } else {
      selection.publicSkipped = picked.skipped;
    }
  } else {
    const candidates = tools
      .filter(isReadOnly)
      .filter((tool) => tool.name !== mode.toolName)
      .map((tool) => ({ tool, schemes: schemesOf(tool) }))
      .filter(({ schemes }) => hasScheme(schemes, "noauth"));
    // A tool that is ONLY public is the cleaner witness; one that offers both
    // still runs anonymously, so it is the fallback rather than excluded.
    const picked =
      candidates.find(({ schemes }) => !hasOAuth2Scheme(schemes)) ??
      candidates[0];
    if (picked) {
      selection.publicTool = { ...picked, selectedBy: "security-schemes" };
    } else {
      selection.publicSkipped =
        'no read-only tool declares securitySchemes with a "noauth" entry; name a public read-only tool to call';
    }
  }

  // ── protected ──
  if (mode.toolName !== undefined) {
    const picked = named(mode.toolName, "protected");
    if (picked.tool) {
      selection.protectedTool = {
        tool: picked.tool,
        selectedBy: "named",
        schemes: schemesOf(picked.tool),
      };
    } else {
      selection.protectedSkipped = picked.skipped;
    }
  } else {
    const picked = tools
      .filter(isReadOnly)
      .filter((tool) => tool.name !== selection.publicTool?.tool.name)
      .map((tool) => ({ tool, schemes: schemesOf(tool) }))
      .find(
        ({ schemes }) =>
          hasOAuth2Scheme(schemes) && !hasScheme(schemes, "noauth"),
      );
    if (picked) {
      selection.protectedTool = { ...picked, selectedBy: "security-schemes" };
    } else {
      selection.protectedSkipped =
        'no read-only tool declares securitySchemes with only an "oauth2" entry; name a protected read-only tool to call';
    }
  }

  return selection;
}

/**
 * Whether a protected call's refusal should send metadata discovery round
 * again, and with which pointer.
 *
 * `accept` is the publisher's rule about which refusals its host follows:
 * Claude acts on an HTTP 401 only, so a pointer that exists only in `_meta` is
 * one Claude never sees. A 401 with no pointer still re-runs discovery, at the
 * well-known paths, which is the spec's own fallback.
 */
export function lazyAuthRediscoveryTrigger(
  call: DirectoryLazyAuthToolCall | undefined,
  accept: readonly AuthChallengeSource[],
):
  | {
      source: AuthChallengeSource;
      pointer?: string;
      trigger: DirectoryLazyAuthRediscovery["trigger"];
    }
  | undefined {
  const signal = call?.challenge;
  const isUnauthorized = call?.outcome === "unauthorized";
  const source: AuthChallengeSource | undefined =
    signal?.source ?? (isUnauthorized ? "http_401" : undefined);
  if (!source || !accept.includes(source)) return undefined;
  const pointer = signal?.resourceMetadataUrl;
  return {
    source,
    ...(pointer ? { pointer } : {}),
    trigger: pointer ? "resource_metadata" : "well-known-fallback",
  };
}
