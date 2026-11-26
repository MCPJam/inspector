/**
 * Client rules for the 2025 (legacy) wire, proven on what MCPJam actually sends.
 *
 * Every legacy-era conformance check runs once, pinned to 2025-11-25, against
 * the stateful mock server (real sessions, real localhost port). The server
 * records each request, tagged with the check that sent it, and each rule is
 * then judged per check. Both client stacks are covered this way: the official
 * client the client-backed checks connect with, and the hand-built raw probes
 * of the protocol, transport and security checks.
 *
 * A rule that some checks break lists them in `KNOWN`; the test fails when the
 * list is wrong in either direction.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_ERAS,
  MCP_CHECK_IDS,
  MCP_LOG_LEVELS,
} from "../../src/mcp-conformance/index.js";
import {
  MCP_PROTOCOL_VERSIONS,
  isStatelessProtocolVersion,
} from "../../src/mcp-client-manager/mcp-protocol-version.js";
import {
  buildFetchCorpus,
  buildLegacyCorpus,
  expectKnownViolations,
  isRpcRequest,
  rpcMethodOf,
  recordingFetch,
  rpcOf,
  ruleTest,
  runOneCheck,
  violationsByCheck,
  type FetchCorpus,
  type LegacyCorpus,
  type WireRequest,
  type WireSession,
} from "./harness.js";
import { createFixtureHandler } from "../support/dual-era-fixture.js";
import { startConformanceMockServer } from "../mock-servers/conformance-mcp-server.js";

const LEGACY_CHECKS: string[] = MCP_CHECK_IDS.filter((id) =>
  CHECK_ERAS[id].includes("legacy"),
);

/** The checks that connect through the official client (MCPClientManager). */
const CLIENT_BACKED_LEGACY_CHECKS = [
  "server-initialize",
  "ping",
  "logging-set-level",
  "completion-complete",
  "capabilities-consistent",
  "tools-list",
  "tools-input-schemas-valid",
  "prompts-list",
  "resources-list",
];

/** Checks known to break a rule, by rule id. Absent means none does. */
const KNOWN: Record<string, string[]> = {
  // SHOULD. MCPClientManager closes the transport on disconnect but never
  // calls the transport's terminateSession, so no DELETE goes out; the raw
  // protocol probe (checks/protocol.ts) opens a session and never ends it.
  C261: [...CLIENT_BACKED_LEGACY_CHECKS, "protocol-invalid-method-error"],
};

const LATEST_LEGACY_VERSION = [...MCP_PROTOCOL_VERSIONS]
  .filter((version) => !isStatelessProtocolVersion(version))
  .sort()
  .at(-1)!;

let corpus: LegacyCorpus;

beforeAll(async () => {
  corpus = await buildLegacyCorpus(LEGACY_CHECKS, {
    protocolVersion: "2025-11-25",
  });
}, 180_000);

/**
 * C003: a session's first request other than ping is notifications/initialized.
 * Returns what went wrong, or undefined.
 */
function judgeInitializedFirst(session: WireSession): string | undefined {
  for (const request of session.requests) {
    const method = rpcMethodOf(request);
    if (method === "notifications/initialized") return undefined;
    if (method === "ping") continue;
    return `sent ${request.httpMethod} ${method ?? ""} before notifications/initialized`.trim();
  }
  return "never sent notifications/initialized";
}

function acceptList(request: WireRequest): string[] {
  return (request.headers.accept ?? "")
    .split(",")
    .map((part) => part.split(";")[0]!.trim().toLowerCase());
}

// Every rule here binds the client as a whole, so it is judged on EVERY legacy
// check, not only the checks the rules page maps to it: the page lists the
// checks it saw demonstrate a rule, and a check it left out can still break it.
describe("legacy wire corpus (2025-11-25, stateful mock server)", () => {
  it("(control) every legacy check but the wire-schema one sent traffic, and the judges can fail", () => {
    for (const check of LEGACY_CHECKS) {
      if (check === "wire-schema-valid") continue;
      expect(corpus.requests.some((request) => request.check === check), check).toBe(true);
    }
    const skipped: WireSession = {
      id: "s",
      check: "x",
      initialize: corpus.requests[0]!,
      requests: [{ ...corpus.requests[0]!, body: { jsonrpc: "2.0", id: 9, method: "tools/list" } }],
    };
    expect(judgeInitializedFirst(skipped)).toMatch(/before notifications\/initialized/);
    expect(judgeInitializedFirst({ ...skipped, requests: [] })).toBe(
      "never sent notifications/initialized",
    );
  });

  ruleTest("C001", "every check's first request is initialize", () => {
    const firstByCheck = new Map<string, WireRequest>();
    for (const request of corpus.requests) {
      if (!firstByCheck.has(request.check)) firstByCheck.set(request.check, request);
    }
    expect(firstByCheck.size).toBeGreaterThan(0);
    expectKnownViolations(
      violationsByCheck([...firstByCheck.values()], (request) =>
        rpcMethodOf(request) === "initialize"
          ? undefined
          : `first request was ${request.httpMethod} ${rpcMethodOf(request) ?? "(no JSON-RPC)"}`,
      ),
      KNOWN.C001,
    );
  });

  ruleTest("C002", "every initialize declares the client's capabilities", () => {
    const initializes = corpus.requests.filter(
      (request) => rpcMethodOf(request) === "initialize",
    );
    expect(initializes.length).toBeGreaterThan(0);
    expectKnownViolations(
      violationsByCheck(initializes, (request) => {
        const capabilities = rpcOf(request)?.params?.capabilities;
        return capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
          ? undefined
          : `params.capabilities was ${JSON.stringify(capabilities)}`;
      }),
      KNOWN.C002,
    );
  });

  ruleTest(
    "C003",
    "every opened session sends notifications/initialized before anything but ping",
    () => {
      const sessions = corpus.sessions;
      expect(sessions.length).toBeGreaterThan(0);
      expectKnownViolations(
        violationsByCheck(sessions, judgeInitializedFirst),
        KNOWN.C003,
      );
    },
  );

  ruleTest("C006", "every logging/setLevel is a request with a level", () => {
    const setLevels = corpus.requests.filter(
      (request) => rpcMethodOf(request) === "logging/setLevel",
    );
    expect(setLevels.length).toBeGreaterThan(0);
    expectKnownViolations(
      violationsByCheck(setLevels, (request) => {
        const rpc = rpcOf(request)!;
        if (!rpc.hasId) return "sent as a notification (no id)";
        return typeof rpc.params?.level === "string"
          ? undefined
          : `params.level was ${JSON.stringify(rpc.params?.level)}`;
      }),
      KNOWN.C006,
    );
  });

  ruleTest("C007", "the logging check asks for a real log level", () => {
    const setLevels = corpus.requests.filter(
      (request) =>
        request.check === "logging-set-level" &&
        rpcMethodOf(request) === "logging/setLevel",
    );
    expect(setLevels.length).toBeGreaterThan(0);
    for (const request of setLevels) {
      expect(MCP_LOG_LEVELS).toContain(rpcOf(request)?.params?.level);
    }
  });

  ruleTest(
    "C009",
    "completion/complete names what it completes with a prompt or resource reference",
    () => {
      const completions = corpus.requests.filter(
        (request) => rpcMethodOf(request) === "completion/complete",
      );
      expect(completions.length).toBeGreaterThan(0);
      expectKnownViolations(
        violationsByCheck(completions, (request) => {
          const params = rpcOf(request)?.params ?? {};
          const ref = params.ref as Record<string, unknown> | undefined;
          const argument = params.argument as Record<string, unknown> | undefined;
          const refOk =
            (ref?.type === "ref/prompt" && typeof ref.name === "string") ||
            (ref?.type === "ref/resource" && typeof ref.uri === "string");
          const argumentOk =
            typeof argument?.name === "string" && typeof argument?.value === "string";
          return refOk && argumentOk
            ? undefined
            : `ref ${JSON.stringify(ref)}, argument ${JSON.stringify(argument)}`;
        }),
        KNOWN.C009,
      );
    },
  );

  ruleTest("C018", "the prompts check lists prompts with prompts/list", () => {
    expect(
      corpus.requests.some(
        (request) =>
          request.check === "prompts-list" && rpcMethodOf(request) === "prompts/list",
      ),
    ).toBe(true);
  });

  ruleTest("C021", "the resources check lists resources with resources/list", () => {
    expect(
      corpus.requests.some(
        (request) =>
          request.check === "resources-list" &&
          rpcMethodOf(request) === "resources/list",
      ),
    ).toBe(true);
  });

  ruleTest("C022", "every request id is a string or an integer", () => {
    expectKnownViolations(
      violationsByCheck(corpus.requests.filter(isRpcRequest), (request) => {
        const id = rpcOf(request)!.id;
        return typeof id === "string" || Number.isInteger(id)
          ? undefined
          : `${rpcMethodOf(request)} had id ${JSON.stringify(id)}`;
      }),
      KNOWN.C022,
    );
  });

  ruleTest("C064", "no request id is null", () => {
    expectKnownViolations(
      violationsByCheck(
        corpus.requests.filter((request) => rpcOf(request)?.method !== undefined),
        (request) => {
          const rpc = rpcOf(request)!;
          return rpc.hasId && rpc.id === null
            ? `${rpc.method} had id null`
            : undefined;
        },
      ),
      KNOWN.C064,
    );
  });

  ruleTest("C065", "no request id repeats within a session", () => {
    expectKnownViolations(
      violationsByCheck(corpus.sessions, (session) => {
        const seen = new Set<string>();
        for (const request of [session.initialize, ...session.requests]) {
          if (!isRpcRequest(request)) continue;
          const key = JSON.stringify(rpcOf(request)!.id);
          if (seen.has(key)) return `id ${key} sent twice (${rpcMethodOf(request)})`;
          seen.add(key);
        }
        return undefined;
      }),
      KNOWN.C065,
    );
  });

  ruleTest(
    "C023",
    "every request on a session carries MCP-Protocol-Version with the negotiated version",
    () => {
      expectKnownViolations(
        violationsByCheck(
          corpus.sessions.flatMap((session) =>
            session.requests.map((request) => ({ ...request, check: session.check })),
          ),
          (request) =>
            request.headers["mcp-protocol-version"] === "2025-11-25"
              ? undefined
              : `${request.httpMethod} ${rpcMethodOf(request) ?? ""} had MCP-Protocol-Version ${JSON.stringify(request.headers["mcp-protocol-version"])}`,
        ),
        KNOWN.C023,
      );
    },
  );

  ruleTest("C024", "every JSON-RPC message goes by POST to the MCP endpoint", () => {
    expectKnownViolations(
      violationsByCheck(
        corpus.requests.filter((request) => request.body !== undefined),
        (request) =>
          request.httpMethod === "POST" && request.path === "/mcp"
            ? undefined
            : `${request.httpMethod} ${request.path}`,
      ),
      KNOWN.C024,
    );
  });

  ruleTest(
    "C025",
    "every POST accepts both application/json and text/event-stream",
    () => {
      expectKnownViolations(
        violationsByCheck(
          corpus.requests.filter((request) => request.httpMethod === "POST"),
          (request) => {
            const accepted = acceptList(request);
            return accepted.includes("application/json") &&
              accepted.includes("text/event-stream")
              ? undefined
              : `${rpcMethodOf(request)} had Accept ${JSON.stringify(request.headers.accept)}`;
          },
        ),
        KNOWN.C025,
      );
    },
  );

  ruleTest(
    "C026",
    "every request after initialize carries a session id the server issued",
    () => {
      const issued = new Set(
        corpus.requests.flatMap((request) =>
          request.mintedSessionId ? [request.mintedSessionId] : [],
        ),
      );
      expectKnownViolations(
        violationsByCheck(
          corpus.requests.filter(
            (request) => rpcMethodOf(request) !== "initialize",
          ),
          (request) => {
            const session = request.headers["mcp-session-id"];
            if (!session) {
              return `${request.httpMethod} ${rpcMethodOf(request) ?? ""} had no Mcp-Session-Id`.trim();
            }
            return issued.has(session) ? undefined : `unknown session ${session}`;
          },
        ),
        KNOWN.C026,
      );
    },
  );

  ruleTest(
    "C028",
    "the checks pass against a server that answers over SSE (this corpus)",
    () => {
      const sse = corpus.requests.filter((request) =>
        request.responseContentType?.startsWith("text/event-stream"),
      );
      expect(sse.length).toBeGreaterThan(0);
      for (const check of ["server-initialize", "ping", "tools-list", "prompts-list"]) {
        expect(corpus.runs.get(check)?.check?.status, check).toBe("passed");
      }
    },
  );

  ruleTest("C029", "every POST carries exactly one JSON-RPC message, never a batch", () => {
    expectKnownViolations(
      violationsByCheck(
        corpus.requests.filter((request) => request.httpMethod === "POST"),
        (request) =>
          Array.isArray(request.body) ? "sent a JSON array (batch)" : undefined,
      ),
      KNOWN.C029,
    );
  });

  ruleTest("C030", "the GET-stream check opens an SSE stream with GET", () => {
    expect(
      corpus.requests.some(
        (request) =>
          request.check === "get-stream-or-405" && request.httpMethod === "GET",
      ),
    ).toBe(true);
  });

  ruleTest("C031", "every GET accepts text/event-stream", () => {
    const gets = corpus.requests.filter((request) => request.httpMethod === "GET");
    expect(gets.length).toBeGreaterThan(0);
    expectKnownViolations(
      violationsByCheck(gets, (request) =>
        acceptList(request).includes("text/event-stream")
          ? undefined
          : `GET had Accept ${JSON.stringify(request.headers.accept)}`,
      ),
      KNOWN.C031,
    );
  });

  ruleTest("C261", "every opened session is ended with an HTTP DELETE", () => {
    expectKnownViolations(
      violationsByCheck(corpus.sessions, (session) =>
        session.requests.some((request) => request.httpMethod === "DELETE")
          ? undefined
          : "session never deleted",
      ),
      KNOWN.C261,
    );
  });
});

describe("legacy wire, other revisions and modes", () => {
  let older: LegacyCorpus;
  let auto: LegacyCorpus;
  let json: FetchCorpus;

  beforeAll(async () => {
    const sample = [
      "server-initialize",
      "tools-list",
      "protocol-invalid-method-error",
      "notification-post-accepted",
      "get-stream-or-405",
    ];
    older = await buildLegacyCorpus(sample, { protocolVersion: "2025-06-18" });
    auto = await buildLegacyCorpus(["server-initialize", "protocol-invalid-method-error"]);
    json = await buildFetchCorpus(
      ["server-initialize", "ping", "tools-list", "prompts-list"],
      createFixtureHandler(),
      { protocolVersion: "2025-11-25" },
    );
  }, 120_000);

  ruleTest(
    "C023",
    "on 2025-06-18 too, every request on a session carries the negotiated MCP-Protocol-Version",
    () => {
      const requests = older.sessions.flatMap((session) =>
        session.requests.map((request) => ({ ...request, check: session.check })),
      );
      expect(requests.length).toBeGreaterThan(0);
      expectKnownViolations(
        violationsByCheck(requests, (request) =>
          request.headers["mcp-protocol-version"] === "2025-06-18"
            ? undefined
            : `${request.httpMethod} ${rpcMethodOf(request) ?? ""} had ${JSON.stringify(request.headers["mcp-protocol-version"])}`,
        ),
        KNOWN.C023_2025_06_18,
      );
    },
  );

  ruleTest("C029", "on 2025-06-18 too, every POST carries one JSON-RPC message", () => {
    const posts = older.requests.filter((request) => request.httpMethod === "POST");
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.filter((request) => Array.isArray(request.body))).toEqual([]);
  });

  ruleTest(
    "C068",
    "an unpinned run proposes the latest legacy version in initialize",
    () => {
      const initializes = auto.requests.filter(
        (request) => rpcMethodOf(request) === "initialize",
      );
      expect(initializes.length).toBeGreaterThan(0);
      expectKnownViolations(
        violationsByCheck(initializes, (request) => {
          const proposed = rpcOf(request)?.params?.protocolVersion;
          return proposed === LATEST_LEGACY_VERSION
            ? undefined
            : `proposed ${JSON.stringify(proposed)}, latest is ${LATEST_LEGACY_VERSION}`;
        }),
        KNOWN.C068,
      );
    },
  );

  ruleTest(
    "C032",
    "the GET-stream check closes the SSE stream it opened, itself",
    async () => {
      // Recorded at the client's fetch: the server alone cannot tell a stream
      // the client closed from one it ended when the session was deleted a
      // fraction of a millisecond later.
      const server = await startConformanceMockServer();
      const sent: WireRequest[] = [];
      try {
        const run = await runOneCheck("get-stream-or-405", {
          serverUrl: server.url,
          protocolVersion: "2025-11-25",
          fetchFn: recordingFetch((request) => fetch(request), sent, () => "get-stream-or-405"),
        });
        expect(run.check?.status).toBe("passed");
      } finally {
        await server.stop();
      }
      const gets = sent.filter((request) => request.httpMethod === "GET");
      expect(gets.length).toBeGreaterThan(0);
      for (const get of gets) {
        expect(get.responseContentType).toMatch(/^text\/event-stream/);
        expect(get.abortedAt, "the client never closed the stream").toBeDefined();
      }
    },
  );

  ruleTest(
    "C027",
    "the functional-streams check has several SSE streams open on one session at once",
    async () => {
      // Hold every tools/list until three are in flight. A client that sent
      // them one after another would never get there: the first would wait
      // out the timeout alone, and the peak would stay at 1.
      const server = await startConformanceMockServer();
      let inFlight = 0;
      let peak = 0;
      let releaseAll!: () => void;
      const allSent = new Promise<void>((resolve) => (releaseAll = resolve));
      const fetchFn: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const body = request.method === "POST"
          ? await request.clone().json().catch(() => undefined)
          : undefined;
        if (body?.method !== "tools/list") return fetch(request);
        inFlight++;
        peak = Math.max(peak, inFlight);
        if (inFlight >= 3) releaseAll();
        await Promise.race([allSent, new Promise((wait) => setTimeout(wait, 1_000))]);
        try {
          return await fetch(request);
        } finally {
          inFlight--;
        }
      };
      try {
        await runOneCheck("server-sse-streams-functional", {
          serverUrl: server.url,
          protocolVersion: "2025-11-25",
          fetchFn,
        });
      } finally {
        await server.stop();
      }
      expect(peak).toBeGreaterThanOrEqual(2);
      // And the corpus shows those POSTs were answered as SSE streams.
      expect(
        corpus.requests.some(
          (request) =>
            request.check === "server-sse-streams-functional" &&
            rpcMethodOf(request) === "tools/list" &&
            request.responseContentType?.startsWith("text/event-stream"),
        ),
      ).toBe(true);
    },
  );

  ruleTest(
    "C028",
    "the checks also pass against a server that answers with a single JSON object",
    () => {
      expect(
        json.requests.some((request) =>
          request.responseContentType?.startsWith("application/json"),
        ),
      ).toBe(true);
      for (const [check, run] of json.runs) {
        expect(run.check?.status, check).toBe("passed");
      }
    },
  );
});
