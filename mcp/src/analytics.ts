/**
 * Usage events for activity on this worker that never reaches `/api/v1`:
 * which agents connect, which skills they read, and which requests the worker
 * refuses before the Platform API. Everything that reaches the API is counted
 * there instead (`api_v1_request_completed`).
 *
 * Sent straight to PostHog's capture endpoint inside `ctx.waitUntil`, so a
 * request never waits on it and a PostHog outage cannot fail one. Off unless
 * `POSTHOG_PROJECT_KEY` is set (staging and production only).
 *
 * Privacy: no tool arguments, results or request bodies; the agent is reduced
 * to a known family (`mcpClientFamily`) and a skill to its name in this
 * worker's own bundle.
 */

import { mcpClientFamily } from "@mcpjam/sdk/internal/telemetry";
import { SKILLS_BUNDLE_ENTRIES } from "./generated/SkillsBundle.generated.js";

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const PROTOCOL_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A JSON-RPC body worth reading for these facts is small; skip anything else. */
const MAX_INSPECTED_BODY_BYTES = 64 * 1024;

export type WorkerEvent =
  | "mcp_session_started"
  | "mcp_skill_read"
  | "mcp_request_rejected";

export type RejectionReason = "invalid_token" | "guest_mint_failed";

/** What one `/mcp` request says about its client, read from its body. */
export type McpRequestFacts = {
  method?: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  /** True when the client identified itself on this request (initialize or a 2026 `_meta`). */
  identified: boolean;
  /** A skill from this worker's bundle that the request reads. */
  skillName?: string;
};

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function skillNameFor(uri: string | undefined): string | undefined {
  if (!uri?.startsWith("skill://")) return undefined;
  const entry = SKILLS_BUNDLE_ENTRIES.find(
    (skill) =>
      skill.uri === uri ||
      uri.startsWith(skill.uri.slice(0, -"SKILL.md".length))
  );
  return text(entry?.frontmatter.name);
}

/**
 * Reads the request's JSON-RPC message from a clone, so the MCP handler still
 * gets the untouched body. A batch, a non-JSON body or an oversized one yields
 * no facts rather than an error: these are labels, never a reason to refuse.
 */
export async function readMcpRequestFacts(
  request: Request
): Promise<McpRequestFacts> {
  const none: McpRequestFacts = { identified: false };
  if (request.method !== "POST") return none;
  // No declared length (a chunked upload) is skipped rather than buffered: a
  // label is not worth reading an unbounded body for.
  const declared = request.headers.get("content-length");
  if (declared === null) return none;
  const length = Number(declared);
  if (!Number.isFinite(length) || length > MAX_INSPECTED_BODY_BYTES) {
    return none;
  }
  let message: Json | undefined;
  try {
    message = record(await request.clone().json());
  } catch {
    // Not JSON: the handler answers that; there is nothing to count.
    return none;
  }
  if (!message) return none;

  const method = text(message.method);
  const params = record(message.params);
  const meta = record(params?._meta);
  const initialize = method === "initialize";
  const clientInfo = record(
    initialize ? params?.clientInfo : meta?.[CLIENT_INFO_META_KEY]
  );
  const protocolVersion = text(
    initialize ? params?.protocolVersion : meta?.[PROTOCOL_VERSION_META_KEY]
  );
  const skillName = skillNameFor(
    method === "skills/get" || method === "resources/read"
      ? text(params?.uri)
      : undefined
  );
  const clientName = text(clientInfo?.name);
  const clientVersion = text(clientInfo?.version);

  return {
    ...(method ? { method } : {}),
    ...(clientName ? { clientName } : {}),
    ...(clientVersion ? { clientVersion } : {}),
    ...(protocolVersion && PROTOCOL_VERSION_PATTERN.test(protocolVersion)
      ? { protocolVersion }
      : {}),
    identified: Boolean(clientName),
    ...(skillName ? { skillName } : {}),
  };
}

type Properties = Record<string, string | boolean>;

export interface WorkerAnalytics {
  capture(
    event: WorkerEvent,
    distinctId: string | undefined,
    properties: Properties
  ): void;
  /** Like `capture`, once `properties` resolves, without holding the response. */
  captureAfter(
    event: WorkerEvent,
    distinctId: string | undefined,
    properties: Promise<Properties>
  ): void;
}

/** The analytics properties shared by every event from one request. */
export function clientProperties(
  facts: McpRequestFacts,
  userAgent: string | null
): Record<string, string> {
  const family = mcpClientFamily(facts.clientName ?? userAgent ?? undefined);
  return {
    ...(family ? { mcp_client: family } : {}),
    ...(facts.protocolVersion
      ? { protocol_version: facts.protocolVersion }
      : {}),
  };
}

export function createWorkerAnalytics(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">
): WorkerAnalytics {
  const key = env.POSTHOG_PROJECT_KEY;
  if (!key) return { capture: () => {}, captureAfter: () => {} };
  const analytics: WorkerAnalytics = {
    captureAfter(event, distinctId, properties) {
      ctx.waitUntil(
        properties.then((resolved) =>
          analytics.capture(event, distinctId, resolved)
        )
      );
    },
    capture(event, distinctId, properties) {
      const body = JSON.stringify({
        api_key: key,
        event,
        // An anonymous rejection still needs an id; it never makes a person.
        distinct_id: distinctId ?? crypto.randomUUID(),
        properties: {
          ...properties,
          source: "mcp_worker",
          $insert_id: crypto.randomUUID(),
          $geoip_disable: true,
          ...(distinctId ? {} : { $process_person_profile: false }),
        },
      });
      ctx.waitUntil(
        fetch(POSTHOG_CAPTURE_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }).then(
          (response) => {
            if (!response.ok) {
              console.warn(`[mcp] analytics capture got ${response.status}`);
            }
          },
          (error: unknown) => {
            console.warn("[mcp] analytics capture failed", String(error));
          }
        )
      );
    },
  };
  return analytics;
}

/** What the MCP server needs from this request's analytics. */
export type McpCaller = {
  /** The agent's own name, for the launcher label on what it starts. */
  clientName?: string;
  onGuestMintFailed(): void;
};

/**
 * Counts one served `/mcp` request: a client identifying itself, and a skill
 * read. Returns what the tools need to label and report the rest.
 */
export function recordMcpRequest(
  analytics: WorkerAnalytics,
  facts: McpRequestFacts,
  request: Request,
  claims: { sub?: unknown; iss?: unknown } | undefined,
  guestIssuer: string
): McpCaller {
  const distinctId = typeof claims?.sub === "string" ? claims.sub : undefined;
  const isGuest = !claims || claims.iss === guestIssuer;
  const shared = {
    ...clientProperties(facts, request.headers.get("user-agent")),
    is_guest: isGuest,
  };
  if (facts.identified) {
    analytics.capture("mcp_session_started", distinctId, shared);
  }
  if (facts.skillName) {
    analytics.capture("mcp_skill_read", distinctId, {
      ...shared,
      skill_name: facts.skillName,
    });
  }
  return {
    ...(facts.clientName ? { clientName: facts.clientName } : {}),
    onGuestMintFailed: () =>
      analytics.capture("mcp_request_rejected", distinctId, {
        ...shared,
        reason: "guest_mint_failed",
      }),
  };
}
