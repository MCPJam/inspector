/**
 * Fixtures for the probe runner tests: a doctor state shaped the way the
 * capture leaves it, a manager and client that record every member touched,
 * and an OAuth-protected server behind a recording fetch.
 */
import { createHash } from "node:crypto";
import { vi } from "vitest";
import type {
  ConnectedServerDoctorState,
  MCPClientManager,
  ProbeSummary,
} from "@mcpjam/sdk";
import type { ServerFeatureCapture } from "../capture.js";

export const SECRET = "s3cret-token-value";
export const SERVER_URL = `https://srv.example.com/mcp?token=${SECRET}`;
export const AS_ORIGIN = "https://auth.example.com";

const ok = { status: "ok" as const, detail: "fine" };

export const markdownFor = (name: string) =>
  `---\nname: ${name}\ndescription: Skill ${name}.\n---\n# ${name}\n`;
export const skillUri = (name: string) => `skill://demo/${name}/SKILL.md`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Skill `a` verifies; skill `b`'s manifest digest does not match its bytes. */
const SKILL_ENTRIES: Record<string, unknown> = Object.fromEntries(
  ["a", "b"].map((name) => {
    const markdown = markdownFor(name);
    return [
      skillUri(name),
      {
        uri: skillUri(name),
        frontmatter: { name, description: `Skill ${name}.` },
        resources: [
          {
            uri: skillUri(name),
            digest: `sha256:${sha256(name === "b" ? `${markdown}tampered` : markdown)}`,
            size: Buffer.byteLength(markdown),
          },
        ],
      },
    ];
  }),
);

/** What the server answers for a skill file read. */
export function skillFile(uri: string) {
  const name = uri.split("/").at(-2) ?? "";
  return { contents: [{ uri, mimeType: "text/markdown", text: markdownFor(name) }] };
}

/** The doctor's state as `collectTools` leaves it: `_meta` lives in `toolsMetadata`. */
export function doctorState(
  overrides: Partial<ConnectedServerDoctorState> = {},
): ConnectedServerDoctorState {
  return {
    initInfo: null,
    capabilities: null,
    tools: [
      { name: "show-chart", inputSchema: { type: "object" } },
      { name: "ask", inputSchema: { type: "object" } },
    ],
    toolsMetadata: {
      "show-chart": { ui: { resourceUri: "ui://chart" } },
      ask: { ui: { resourceUri: "ui://needs-input" } },
    },
    resources: [
      { uri: "ui://chart", name: "chart", mimeType: "text/html;profile=mcp-app" },
      { uri: "file:///private/notes.txt", name: "notes" },
    ],
    resourceTemplates: [],
    prompts: [{ name: "summarize" }],
    skills: [
      { skillUri: skillUri("a"), name: "a" },
      { skillUri: skillUri("b"), name: "b" },
    ],
    checks: {
      initialization: ok,
      capabilities: ok,
      tools: ok,
      resources: ok,
      resourceTemplates: ok,
      prompts: ok,
      skills: { status: "ok", detail: "2 skills discovered." },
    },
    errors: [],
    ...overrides,
  };
}

export function capture(
  transport: "streamable-http" | "stdio" = "streamable-http",
  doctor: ConnectedServerDoctorState | undefined = doctorState(),
  era: "legacy" | "modern" = "modern",
): ServerFeatureCapture {
  const protocolVersion = era === "modern" ? "2026-07-28" : "2025-11-25";
  return {
    snapshot: {
      version: 3,
      capturedAt: 1,
      servers: [
        {
          serverId: "srv_1",
          tools: [],
          transport,
          discovery: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "srv", version: "1.0.0" },
          },
        },
      ],
    },
    context: { transport, era, protocolVersion },
    contextHash: "ctx_0123456789abcdef",
    ...(doctor ? { doctor } : {}),
  };
}

export const HTML = {
  uri: "ui://chart",
  mimeType: "text/html;profile=mcp-app",
  text: "<!doctype html><html><body>chart</body></html>",
  _meta: { ui: { csp: { connectDomains: [] }, prefersBorder: true } },
};

/** A fake stands in for the manager; only the members the probes touch exist. */
export function asManager(fake: object): MCPClientManager {
  return fake as MCPClientManager;
}

/** The server sending `elicitation/create` on this connection, as the client would dispatch it. */
export type Elicit = () => Promise<unknown>;
export type ReadAnswer = (
  uri: string,
  signal: AbortSignal | undefined,
  elicit: Elicit,
) => Promise<unknown>;

/**
 * A manager and client that record every member touched. Anything outside the
 * read-only surface the probes may use throws, so a forbidden call fails the
 * probe and shows up in `forbidden`.
 */
export function recordingManager(
  options: {
    read?: ReadAnswer;
    listServerEvents?: (
      elicit: Elicit,
      signal: AbortSignal | undefined,
    ) => Promise<unknown>;
    eventsDeclared?: boolean;
  } = {},
) {
  // The user's own elicitation handling, and the probe's override if any.
  const userHandler = vi.fn(async () => ({ action: "accept", content: { pick: "a" } }));
  let serverSpecific: (() => unknown) | undefined;
  const elicit: Elicit = async () => (serverSpecific ?? userHandler)();
  const forbidden: string[] = [];
  const managerCalls: string[] = [];
  const reads: string[] = [];
  const read: ReadAnswer = async (uri, signal, ask) => {
    if (options.read) return options.read(uri, signal, ask);
    if (uri.startsWith("skill://")) return skillFile(uri);
    return uri === "ui://needs-input"
      ? { resultType: "input_required", inputRequests: {} }
      : { contents: [HTML] };
  };
  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        if (prop === "readResource") {
          return (params: { uri: string }, requestOptions?: { signal?: AbortSignal }) => {
            reads.push(params.uri);
            return read(params.uri, requestOptions?.signal, elicit);
          };
        }
        return () => {
          forbidden.push(`client.${String(prop)}`);
          throw new Error(`forbidden client.${String(prop)}`);
        };
      },
    },
  );
  const allowed: Record<string, unknown> = {
    getManagedClient: () => client,
    getEventsSupport: () => ({
      handshakeObserved: true,
      declared: options.eventsDeclared ?? true,
      listChanged: false,
    }),
    setElicitationHandler: (_key: string, handler: () => unknown) => {
      serverSpecific = handler;
    },
    clearElicitationHandler: () => {
      serverSpecific = undefined;
    },
    getServerSkillResult: async (_key: string, uri: string) => ({
      skill: SKILL_ENTRIES[uri],
    }),
    listServerEvents: options.listServerEvents
      ? (_key: string, _params: unknown, requestOptions?: { signal?: AbortSignal }) =>
          options.listServerEvents?.(elicit, requestOptions?.signal)
      : (async () => ({
        events: [
          {
            name: "build.finished",
            description: "A build finished",
            delivery: ["poll", "webhook"],
            inputSchema: { type: "object" },
            payloadSchema: { type: "object" },
          },
        ],
      })),
  };
  const manager = asManager(new Proxy(allowed, {
    get(target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      managerCalls.push(prop);
      if (Object.hasOwn(target, prop)) return target[prop];
      return () => {
        forbidden.push(`manager.${prop}`);
        throw new Error(`forbidden manager.${prop}`);
      };
    },
  }));
  return { manager, forbidden, managerCalls, reads, userHandler, elicit };
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** An OAuth-protected server with public metadata, and every request recorded. */
export function recordingFetch() {
  const calls: Recorded[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (init?.method === "POST") {
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="https://srv.example.com/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    }
    if (url.startsWith("https://srv.example.com/.well-known/oauth-protected-resource")) {
      return json({
        resource: `https://srv.example.com/mcp?token=${SECRET}`,
        authorization_servers: [AS_ORIGIN],
        scopes_supported: ["read"],
      });
    }
    if (url === `${AS_ORIGIN}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: AS_ORIGIN,
        authorization_endpoint: `${AS_ORIGIN}/authorize`,
        token_endpoint: `${AS_ORIGIN}/token`,
        registration_endpoint: `${AS_ORIGIN}/register`,
        grant_types_supported: ["authorization_code", "client_credentials"],
        code_challenge_methods_supported: ["S256"],
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
        client_id_metadata_document_supported: true,
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchFn, calls };
}

export function byId(summaries: ProbeSummary[]) {
  return Object.fromEntries(summaries.map((summary) => [summary.probeId, summary]));
}
