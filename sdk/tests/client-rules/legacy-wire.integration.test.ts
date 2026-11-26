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
 * Each test checks exactly what its rule says. A rule that some checks break
 * lists them in `KNOWN`; the test fails when the list is wrong either way.
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
  exercised,
  expectKnownViolations,
  isRpcRequest,
  mayRule,
  rpcMethodOf,
  rpcOf,
  ruleTest,
  violationsByCheck,
  type FetchCorpus,
  type LegacyCorpus,
  type WireRequest,
  type WireSession,
} from "./harness.js";
import { createFixtureHandler } from "../support/dual-era-fixture.js";

const LEGACY_CHECKS: string[] = MCP_CHECK_IDS.filter((id) =>
  CHECK_ERAS[id].includes("legacy"),
);

/** Checks known to break a rule, by rule id. Absent means none does. */
const KNOWN: Record<string, string[]> = {};

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

/** C003: the session sent notifications/initialized. */
function judgeInitializedSent(session: WireSession): string | undefined {
  return session.requests.some(
    (request) => rpcMethodOf(request) === "notifications/initialized",
  )
    ? undefined
    : "never sent notifications/initialized";
}

/** C023: the request carries an MCP-Protocol-Version header. */
function judgeVersionHeaderSent(request: WireRequest): string | undefined {
  return request.headers["mcp-protocol-version"]
    ? undefined
    : `${request.httpMethod} ${rpcMethodOf(request) ?? ""} had no MCP-Protocol-Version`.trim();
}

function acceptList(request: WireRequest): string[] {
  return (request.headers.accept ?? "")
    .split(",")
    .map((part) => part.split(";")[0]!.trim().toLowerCase());
}

/** Every request after initialize, tagged with the check that opened its session. */
function requestsOnSessions(sessions: readonly WireSession[]): WireRequest[] {
  return sessions.flatMap((session) =>
    session.requests.map((request) => ({ ...request, check: session.check })),
  );
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
    const sample = corpus.requests[0]!;
    expect(judgeInitializedSent({ id: "s", check: "x", initialize: sample, requests: [] })).toBe(
      "never sent notifications/initialized",
    );
    expect(judgeVersionHeaderSent({ ...sample, headers: {} })).toMatch(/no MCP-Protocol-Version/);
  });

  ruleTest(
    "C001",
    "nothing is sent before the initialize that opens a connection",
    () => {
      // A request without a session id belongs to no connection yet, so it
      // must be the initialize that opens one.
      expectKnownViolations(
        violationsByCheck(
          corpus.requests.filter((request) => !request.headers["mcp-session-id"]),
          (request) =>
            rpcMethodOf(request) === "initialize"
              ? undefined
              : `${request.httpMethod} ${rpcMethodOf(request) ?? "(no JSON-RPC)"} before any initialize`,
        ),
        KNOWN.C001,
      );
    },
  );

  ruleTest("C002", "every initialize declares the client's capabilities", (context) => {
    const initializes = corpus.requests.filter(
      (request) => rpcMethodOf(request) === "initialize",
    );
    exercised(context, initializes.length > 0, "no initialize was sent");
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
    "every session a good initialize opened sends notifications/initialized",
    (context) => {
      exercised(context, corpus.sessions.length > 0, "no session was opened");
      expectKnownViolations(
        violationsByCheck(corpus.sessions, judgeInitializedSent),
        KNOWN.C003,
      );
    },
  );

  ruleTest(
    "C006",
    "every logging/setLevel is a request whose level is one of the spec's levels",
    (context) => {
      const setLevels = corpus.requests.filter(
        (request) => rpcMethodOf(request) === "logging/setLevel",
      );
      exercised(context, setLevels.length > 0, "no logging/setLevel was sent");
      expectKnownViolations(
        violationsByCheck(setLevels, (request) => {
          const rpc = rpcOf(request)!;
          if (!rpc.hasId) return "sent as a notification (no id)";
          return (MCP_LOG_LEVELS as readonly unknown[]).includes(rpc.params?.level)
            ? undefined
            : `params.level was ${JSON.stringify(rpc.params?.level)}`;
        }),
        KNOWN.C006,
      );
    },
  );

  mayRule(
    "C007",
    "MCPJam does send logging/setLevel (the logging check, and the client on connect); the request's form is C006",
  );

  ruleTest(
    "C009",
    "completion/complete names what it completes with a prompt or resource reference",
    (context) => {
      const completions = corpus.requests.filter(
        (request) => rpcMethodOf(request) === "completion/complete",
      );
      exercised(context, completions.length > 0, "no completion/complete was sent");
      expectKnownViolations(
        violationsByCheck(completions, (request) => {
          const ref = rpcOf(request)?.params?.ref as Record<string, unknown> | undefined;
          return (ref?.type === "ref/prompt" && typeof ref.name === "string") ||
            (ref?.type === "ref/resource" && typeof ref.uri === "string")
            ? undefined
            : `ref ${JSON.stringify(ref)}`;
        }),
        KNOWN.C009,
      );
    },
  );

  ruleTest("C018", "the prompts check lists prompts with prompts/list", (context) => {
    // The check passing means it listed the server's prompts.
    exercised(
      context,
      corpus.runs.get("prompts-list")?.check?.status === "passed",
      "the prompts check did not list prompts",
    );
    expect(
      corpus.requests.some(
        (request) =>
          request.check === "prompts-list" && rpcMethodOf(request) === "prompts/list",
      ),
    ).toBe(true);
  });

  ruleTest("C021", "the resources check lists resources with resources/list", (context) => {
    exercised(
      context,
      corpus.runs.get("resources-list")?.check?.status === "passed",
      "the resources check did not list resources",
    );
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
    "every request after initialize carries an MCP-Protocol-Version header",
    () => {
      // The MUST is the header itself; that its value is the negotiated
      // version is a separate SHOULD.
      expectKnownViolations(
        violationsByCheck(requestsOnSessions(corpus.sessions), judgeVersionHeaderSent),
        KNOWN.C023,
      );
    },
  );

  ruleTest("C024", "every JSON-RPC message goes by POST to the MCP endpoint", () => {
    expectKnownViolations(
      violationsByCheck(
        corpus.requests.filter((request) => rpcOf(request) !== undefined),
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

  mayRule(
    "C027",
    "MCPJam does: the functional-streams check keeps three POST answers open as SSE streams at once",
  );

  ruleTest(
    "C028",
    "the client gets its answers from a server that answers over SSE (this corpus)",
    (context) => {
      exercised(
        context,
        corpus.requests.some((request) =>
          request.responseContentType?.startsWith("text/event-stream"),
        ),
        "the server answered nothing over SSE",
      );
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

  mayRule(
    "C030",
    "MCPJam does: the GET-stream check and the official client open an SSE stream with GET; its Accept header is C031",
  );

  ruleTest("C031", "every GET accepts text/event-stream", (context) => {
    const gets = corpus.requests.filter((request) => request.httpMethod === "GET");
    exercised(context, gets.length > 0, "no GET was sent");
    expectKnownViolations(
      violationsByCheck(gets, (request) =>
        acceptList(request).includes("text/event-stream")
          ? undefined
          : `GET had Accept ${JSON.stringify(request.headers.accept)}`,
      ),
      KNOWN.C031,
    );
  });

  mayRule(
    "C032",
    "MCPJam does: the GET-stream check closes the stream it opened once it has the headers",
  );

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
    "on 2025-06-18 too, every request after initialize carries an MCP-Protocol-Version header",
    (context) => {
      const requests = requestsOnSessions(older.sessions);
      exercised(context, requests.length > 0, "no request followed an initialize");
      expectKnownViolations(
        violationsByCheck(requests, judgeVersionHeaderSent),
        KNOWN.C023_2025_06_18,
      );
    },
  );

  ruleTest("C029", "on 2025-06-18 too, every POST carries one JSON-RPC message", () => {
    const posts = older.requests.filter((request) => request.httpMethod === "POST");
    expect(posts.filter((request) => Array.isArray(request.body))).toEqual([]);
  });

  ruleTest(
    "C068",
    "an unpinned run proposes the latest legacy version in initialize",
    (context) => {
      const initializes = auto.requests.filter(
        (request) => rpcMethodOf(request) === "initialize",
      );
      exercised(context, initializes.length > 0, "no initialize was sent");
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
    "C028",
    "the client also gets its answers from a server that answers with a single JSON object",
    (context) => {
      exercised(
        context,
        json.requests.some((request) =>
          request.responseContentType?.startsWith("application/json"),
        ),
        "the server answered nothing as a single JSON object",
      );
      for (const [check, run] of json.runs) {
        expect(run.check?.status, check).toBe("passed");
      }
    },
  );
});
