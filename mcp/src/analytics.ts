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

import {
  mcpClientFamily,
  telemetryRecord,
} from "@mcpjam/sdk/internal/telemetry";
import { SKILLS_BUNDLE_ENTRIES } from "./generated/SkillsBundle.generated.js";

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const PROTOCOL_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A client's first message: the 2025 handshake, or the 2026 discovery call
 * that selects a 2026 protocol version. A 2026 client names itself on every
 * request, so only these count as a session starting.
 */
const FIRST_CONTACT_METHODS = new Set(["initialize", "server/discover"]);
/** A JSON-RPC body worth reading for these facts is small; skip anything else. */
const MAX_INSPECTED_BODY_BYTES = 64 * 1024;

export type WorkerEvent =
  | "mcp_session_started"
  | "mcp_skill_read"
  | "mcp_request_rejected";

/** What one `/mcp` request says about its client, read from its body. */
export type McpRequestFacts = {
  method?: string;
  clientName?: string;
  protocolVersion?: string;
  /** The client's first message, naming itself. */
  startsSession: boolean;
  /** A skill from this worker's bundle whose `SKILL.md` the request reads. */
  skillName?: string;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Only the skill's own `SKILL.md` counts, so one use is one read. */
function skillNameFor(method: string | undefined, uri: unknown) {
  if (method !== "skills/get" && method !== "resources/read") return undefined;
  const entry = SKILLS_BUNDLE_ENTRIES.find((skill) => skill.uri === uri);
  return text(entry?.frontmatter.name);
}

/**
 * The body of a clone, so the MCP handler still reads the untouched request.
 * Stops at the size cap whether or not the request declared a length.
 */
async function readBoundedBody(request: Request): Promise<string | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_INSPECTED_BODY_BYTES)) {
    return undefined;
  }
  const body = request.clone().body;
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_INSPECTED_BODY_BYTES) {
      // Not awaited: cancelling one branch of a tee settles only once the
      // handler has read the other, which happens after this returns.
      reader.cancel().catch((error: unknown) => {
        console.debug("[mcp] analytics could not cancel a body read", String(error));
      });
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Reads the request's JSON-RPC message. A batch, a non-JSON body or an
 * oversized one yields no facts rather than an error: these are labels, never
 * a reason to refuse.
 */
export async function readMcpRequestFacts(
  request: Request
): Promise<McpRequestFacts> {
  const none: McpRequestFacts = { startsSession: false };
  if (request.method !== "POST") return none;
  let message: Record<string, unknown>;
  try {
    const body = await readBoundedBody(request);
    if (body === undefined) return none;
    message = telemetryRecord(JSON.parse(body));
  } catch (error) {
    // The handler answers a body it cannot read; there is nothing to count.
    console.debug("[mcp] analytics skipped an unreadable body", String(error));
    return none;
  }

  const method = text(message.method);
  const params = telemetryRecord(message.params);
  const meta = telemetryRecord(params._meta);
  const initialize = method === "initialize";
  const clientInfo = telemetryRecord(
    initialize ? params.clientInfo : meta[CLIENT_INFO_META_KEY]
  );
  const protocolVersion = text(
    initialize ? params.protocolVersion : meta[PROTOCOL_VERSION_META_KEY]
  );
  const clientName = text(clientInfo.name);
  const skillName = skillNameFor(method, params.uri);

  return {
    ...(method ? { method } : {}),
    ...(clientName ? { clientName } : {}),
    ...(protocolVersion && PROTOCOL_VERSION_PATTERN.test(protocolVersion)
      ? { protocolVersion }
      : {}),
    startsSession: Boolean(
      clientName && method && FIRST_CONTACT_METHODS.has(method)
    ),
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
  if (!key) return { capture: () => {} };
  return {
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
}

/** What the MCP server needs from this request's analytics. */
export type McpCaller = {
  /** The agent's own name, for the launcher label on what it starts. */
  clientName?: string;
  onGuestMintFailed(): void;
};

/**
 * Counts one served `/mcp` request: a client's first contact, and a skill
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
  if (facts.startsSession) {
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
