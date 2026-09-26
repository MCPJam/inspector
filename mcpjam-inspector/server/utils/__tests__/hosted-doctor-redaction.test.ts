/**
 * MJ-001 acceptance 4: a hosted doctor failure does not reflect the upstream,
 * and does not tell open ports from closed ones.
 *
 * The finding's Scenario B was not a body leak — it was two different error
 * strings. `connect ECONNREFUSED 127.0.0.1:6379` for a closed port and
 * `tls_get_more_records:packet length too long` for an open cleartext one, both
 * copied verbatim out of the socket and into the diagnostic envelope. That
 * differential is the port scanner, so the test that matters asserts the two
 * responses are INDISTINGUISHABLE rather than that either one is sanitized.
 *
 * Driven against the redaction directly rather than through a live doctor run:
 * the strings below are the ones the report captured, and pinning them exactly
 * is the point. That the route applies this to its result is covered in
 * `servers-doctor-egress.test.ts`; that the target is refused before a socket
 * exists at all is `hosted-mcp-base-fetch.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeServerDoctorError,
  type ProbeHttpAttempt,
  type ServerDoctorError,
} from "@mcpjam/sdk";

type DoctorEnvelope = {
  probe: {
    status?: string;
    /** The probe's own top-level error — see the note in the redactor. */
    error?: string;
    transport: { attempts: ProbeHttpAttempt[] };
    /** Set by the probe when RFC 9728 discovery failed — see the redactor. */
    oauth?: { discoveryError?: string };
  } | null;
  connection: { status: string; detail: string };
  checks: Record<string, { status: string; detail: string }>;
  error: ServerDoctorError | null;
};

/**
 * The attempt shape the probe really records, not a convenient subset.
 *
 * An earlier version of this file hand-wrote three keys per attempt and a
 * hardcoded `error.code`. That is what made the indistinguishability assertion
 * pass: the fields that still carried the differential — `durationMs`, and a
 * `code` the probe derives from the message by substring — were simply absent
 * from the fixture. Everything a real `ProbeHttpAttempt` carries is spelled out
 * here so the assertion is a test of the redaction rather than of the fixture.
 */
function failedAttempt(
  url: string,
  error: string,
  durationMs: number
): ProbeHttpAttempt {
  return {
    name: "streamable_initialize",
    request: {
      method: "POST",
      url,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    },
    error,
    durationMs,
  };
}

function answeredAttempt(
  url: string,
  response: NonNullable<ProbeHttpAttempt["response"]>,
  durationMs: number
): ProbeHttpAttempt {
  return {
    name: "streamable_initialize",
    request: {
      method: "POST",
      url,
      headers: { accept: "application/json, text/event-stream" },
    },
    response,
    durationMs,
  };
}

/**
 * A doctor result whose only outcome was a socket error — no HTTP response.
 *
 * `durationMs` is the caller's, because it is half the oracle: a refused port
 * comes back in about a millisecond and a filtered one burns the whole timeout.
 * The error is derived the way the doctor derives it rather than written by
 * hand, so the code under test sees the real `SERVER_UNREACHABLE` /
 * `INTERNAL_ERROR` / `TIMEOUT` split.
 */
function socketFailureEnvelope(
  socketError: string,
  durationMs = 1
): DoctorEnvelope {
  return {
    probe: {
      status: "error",
      // `createProbeErrorResult` copies the transport message here verbatim,
      // one key above the per-attempt errors. The first version of this
      // redaction rewrote the attempts and left this field alone, so the port
      // oracle survived in full — every case below asserts on the whole
      // serialised envelope for that reason, not on named fields.
      error: socketError,
      transport: {
        attempts: [
          failedAttempt("https://mcp.example.test/mcp", socketError, durationMs),
        ],
      },
    },
    connection: { status: "error", detail: socketError },
    checks: {
      probe: { status: "error", detail: `HTTP probe failed: ${socketError}` },
      connection: { status: "error", detail: socketError },
      tools: { status: "skipped", detail: "Tools were not collected." },
    },
    error: normalizeServerDoctorError(new Error(socketError)),
  };
}

/**
 * Scenario B routed through OAuth discovery. The server URL answers a
 * challenge; the metadata host it names is a second origin, picked by whoever
 * controls the target, and `oauth.discoveryError` is the only field that
 * reports what happened when the inspector dialled it.
 */
function oauthDiscoveryEnvelope(
  metadataError: string,
  durationMs = 1
): DoctorEnvelope {
  const challenge = answeredAttempt(
    "https://mcp.example.test/mcp",
    {
      status: 401,
      statusText: "Unauthorized",
      headers: {
        "www-authenticate":
          'Bearer resource_metadata="https://metadata.example.test/prm"',
      },
      contentType: "application/json",
    },
    7
  );
  const discovery = failedAttempt(
    "https://metadata.example.test/prm",
    metadataError,
    durationMs
  );
  discovery.name = "resource_metadata";
  discovery.request.method = "GET";

  return {
    probe: {
      status: "oauth_required",
      transport: { attempts: [challenge, discovery] },
      oauth: { discoveryError: metadataError },
    },
    connection: { status: "error", detail: metadataError },
    checks: {
      resourceMetadata: { status: "error", detail: metadataError },
    },
    error: normalizeServerDoctorError(new Error(metadataError)),
  };
}

async function loadRedactor(hosted: boolean) {
  const previous = process.env.VITE_MCPJAM_HOSTED_MODE;
  process.env.VITE_MCPJAM_HOSTED_MODE = hosted ? "true" : "false";
  vi.resetModules();
  const { redactHostedDoctorTransportDetail } = await import(
    "../hosted-doctor-redaction.js"
  );
  return {
    redact: redactHostedDoctorTransportDetail,
    restore: () => {
      if (previous === undefined) delete process.env.VITE_MCPJAM_HOSTED_MODE;
      else process.env.VITE_MCPJAM_HOSTED_MODE = previous;
      vi.resetModules();
    },
  };
}

const CLOSED_PORT = "connect ECONNREFUSED 127.0.0.1:6379";
const OPEN_CLEARTEXT_PORT =
  "error:0A00010B:SSL routines:ssl3_get_record:wrong version number:../deps/openssl/openssl/ssl/record/ssl3_record.c:354: tls_get_more_records:packet length too long";

describe("hosted doctor transport-detail redaction", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("makes an open port indistinguishable from a closed one", async () => {
    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    // The durations are the ones the two outcomes really produce: a refused
    // port answers immediately, an open cleartext one is still negotiating when
    // the timeout fires.
    const closed = loaded.redact(socketFailureEnvelope(CLOSED_PORT, 1));
    const open = loaded.redact(
      socketFailureEnvelope(OPEN_CLEARTEXT_PORT, 9_984)
    );

    expect(JSON.stringify(closed)).toBe(JSON.stringify(open));
  });

  it("leaves no socket, TLS or address detail anywhere in the envelope", async () => {
    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    for (const socketError of [CLOSED_PORT, OPEN_CLEARTEXT_PORT]) {
      const serialized = JSON.stringify(
        loaded.redact(socketFailureEnvelope(socketError))
      );
      expect(serialized).not.toMatch(/ECONNREFUSED/);
      expect(serialized).not.toMatch(/tls_get_more_records/);
      expect(serialized).not.toMatch(/ssl3_get_record/);
      expect(serialized).not.toMatch(/127\.0\.0\.1/);
      expect(serialized).not.toMatch(/6379/);
    }
  });

  it("keeps the egress refusal's own wording, which names no resolved address", async () => {
    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    const refusal =
      'Refusing to connect to "redirector.example.test": it is not a publicly routable address.';
    const redacted = loaded.redact(socketFailureEnvelope(refusal));

    // This one detail helps the person whose URL it is, and it is already
    // oracle-safe: the address the hostname resolved to is on `cause`, never
    // in the message.
    expect(redacted.connection.detail).toBe(refusal);
    expect(redacted.error?.message).toBe(refusal);
    expect(redacted.probe?.error).toBe(refusal);
  });

  it("reports an answered attempt through its projection once nothing dialled after it", async () => {
    // A target that produced an HTTP response keeps its status, its latency
    // and a validated projection of the protocol answer (MJ-001). Summary text
    // that is not SDK wording is replaced with a fixed sentence.
    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    const envelope = socketFailureEnvelope("initialize failed: -32600");
    envelope.probe!.transport.attempts[0] = answeredAttempt(
      "https://mcp.example.test/mcp",
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32600, message: "not echoed" },
        },
      },
      12
    );
    envelope.connection = {
      status: "skipped",
      detail: "Server requires OAuth before a connection can be established.",
    };
    envelope.checks.connection = envelope.connection;

    const redacted = loaded.redact(envelope);
    const attempt = redacted.probe!.transport.attempts[0];
    expect(attempt.response?.status).toBe(200);
    expect(attempt.durationMs).toBe(12);
    expect(attempt.response).not.toHaveProperty("body");
    expect(attempt.response).toMatchObject({
      bodyOmitted: true,
      projection: { kind: "jsonrpc_error", code: -32600 },
    });
    expect(redacted.probe!.error).not.toBe("initialize failed: -32600");
    expect(redacted.error?.message).not.toBe("initialize failed: -32600");
    expect(redacted.connection.detail).toBe(
      "Server requires OAuth before a connection can be established.",
    );
    expect(JSON.stringify(redacted)).not.toMatch(/not echoed/);
  });

  it("redacts the connect leg's failure even when every probe attempt answered", async () => {
    // The connect leg runs after the probe and records no attempt of its own,
    // so an attempts-only exemption let a target that answers the probe and
    // then redirects the connect elsewhere reflect that socket outcome verbatim
    // on `connection.detail`, `checks.connection.detail` and `error`.
    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    const connectFailure = (socketError: string) => {
      const envelope = socketFailureEnvelope(socketError);
      envelope.probe!.status = "ok";
      delete envelope.probe!.error;
      envelope.probe!.transport.attempts[0] = answeredAttempt(
        "https://mcp.example.test/mcp",
        {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        },
        12
      );
      envelope.checks.probe = {
        status: "ok",
        detail: "Server answered the HTTP probe.",
      };
      return envelope;
    };

    const closed = loaded.redact(connectFailure(CLOSED_PORT));
    const open = loaded.redact(connectFailure(OPEN_CLEARTEXT_PORT));

    expect(JSON.stringify(closed)).toBe(JSON.stringify(open));
    expect(JSON.stringify(closed)).not.toMatch(
      /ECONNREFUSED|tls_get_more_records|6379|127\.0\.0\.1/
    );
    // The answered probe attempt is still the product.
    expect(closed.probe!.transport.attempts[0].response?.status).toBe(200);
  });

  it("collapses the error code with the message it was derived from", async () => {
    // `normalizeServerDoctorError` reads the code off the raw message, so a
    // refused connect, an unparseable TLS record and a timeout arrive as three
    // different codes for three outcomes the message alone no longer separates.
    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    const codes = [
      CLOSED_PORT,
      OPEN_CLEARTEXT_PORT,
      "Request timed out after 10000ms",
    ].map((socketError) => {
      const raw = socketFailureEnvelope(socketError);
      const before = raw.error?.code;
      return { before, after: loaded.redact(raw).error?.code };
    });

    expect(codes.map((entry) => entry.before)).toEqual([
      "SERVER_UNREACHABLE",
      "INTERNAL_ERROR",
      "TIMEOUT",
    ]);
    expect(new Set(codes.map((entry) => entry.after)).size).toBe(1);
  });

  it("does nothing in local mode, where the socket error is the answer", async () => {
    const loaded = await loadRedactor(false);
    restore = loaded.restore;

    const redacted = loaded.redact(socketFailureEnvelope(CLOSED_PORT));
    expect(redacted.connection.detail).toBe(CLOSED_PORT);
    expect(redacted.error?.message).toBe(CLOSED_PORT);
  });

  it("makes the metadata host's open and closed ports indistinguishable", async () => {
    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    const closed = loaded.redact(oauthDiscoveryEnvelope(CLOSED_PORT, 1));
    const open = loaded.redact(
      oauthDiscoveryEnvelope(OPEN_CLEARTEXT_PORT, 9_984)
    );

    expect(JSON.stringify(closed)).toBe(JSON.stringify(open));
    expect(JSON.stringify(closed)).not.toMatch(
      /ECONNREFUSED|6379|127\.0\.0\.1/
    );
    expect(closed.probe?.oauth?.discoveryError).toBe(closed.connection.detail);
  });

  it("keeps an egress refusal's own wording on the discovery error", async () => {
    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    const refusal =
      'Request URL hostname "metadata.example.test" resolves to a private or internal address that the hosted inspector will not dial.';
    const redacted = loaded.redact(oauthDiscoveryEnvelope(refusal));

    expect(redacted.probe?.oauth?.discoveryError).toBe(refusal);
  });

  it("leaves the discovery error alone outside hosted mode", async () => {
    const loaded = await loadRedactor(false);
    restore = loaded.restore;

    const redacted = loaded.redact(oauthDiscoveryEnvelope(CLOSED_PORT));
    expect(redacted.probe?.oauth?.discoveryError).toBe(CLOSED_PORT);
  });

  it("redacts a refused attempt even when a sibling attempt answered", async () => {
    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    const envelope = socketFailureEnvelope("initialize failed: -32600");
    envelope.probe!.transport.attempts[0] = answeredAttempt(
      "https://mcp.example.test/mcp",
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      },
      12
    );
    // An answered attempt can still carry an MCP-level error: the host
    // responded, the payload was a JSON-RPC failure.
    envelope.probe!.transport.attempts[0].error = "initialize failed: -32600";
    envelope.probe!.transport.attempts.push(
      failedAttempt("https://mcp.example.test/sse", CLOSED_PORT, 1)
    );

    const redacted = loaded.redact(envelope);

    // The answered attempt keeps its response; free-form error text on it is
    // replaced like any other summary text. The refused one is a socket
    // outcome against whatever the second transport dialled, and used to ride
    // out on the first's response.
    expect(redacted.probe!.transport.attempts[0].response?.status).toBe(200);
    expect(redacted.probe!.transport.attempts[0].error).toBe(
      "The request failed after the server answered.",
    );
    expect(redacted.probe!.transport.attempts[1].error).toBe(
      redacted.connection.detail
    );
    // The refused hop's stopwatch went with its message.
    expect(redacted.probe!.transport.attempts[0].durationMs).toBe(12);
    expect(redacted.probe!.transport.attempts[1].durationMs).toBe(0);
    expect(JSON.stringify(redacted)).not.toMatch(
      /ECONNREFUSED|6379|127\.0\.0\.1/
    );
  });

  it("does not let a socket error smuggle the refusal wording past the redactor", async () => {
    // The allowlist used to be two bare substring tests, so it asked whether
    // the phrase appeared ANYWHERE in the detail rather than whether the detail
    // WAS a refusal. A target that can get text into the transport message —
    // through a certificate subject, a SAN, or a redirect echoed back — only
    // had to include the phrase to carry its own socket outcome out with it.
    // Each string below is a real open-versus-closed differential wearing the
    // refusal's words.
    const smuggled = [
      `${CLOSED_PORT} (not a publicly routable address)`,
      "certificate subject CN=it is not a publicly routable address, " +
        "connect ECONNREFUSED 127.0.0.1:6379",
      'Refusing to connect to "a.test": it is not a publicly routable ' +
        "address. connect ECONNREFUSED 127.0.0.1:6379",
      "resolves to a private or internal address that the hosted inspector " +
        "will not dial. ssl3_get_record:wrong version number",
      // Leading text: the label span used to be `^[^"]*`, which swallowed any
      // quote-free prefix, so the socket outcome only had to come FIRST.
      "connect ECONNREFUSED 127.0.0.1:6379; Server URL hostname " +
        '"a.test" resolves to a private or internal address that the hosted ' +
        "inspector will not dial.",
      "ssl3_get_record:wrong version number Server URL points at a private " +
        'or internal address ("10.0.0.1") that the hosted inspector will not ' +
        "dial. Run this server locally in the inspector instead.",
      // Socket text inside the quoted host field.
      'Refusing to connect to "a.test: connect ECONNREFUSED 127.0.0.1:6379 ' +
        '": it is not a publicly routable address.',
    ];

    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    for (const detail of smuggled) {
      const serialized = JSON.stringify(
        loaded.redact(socketFailureEnvelope(detail))
      );
      expect(serialized).not.toMatch(/ECONNREFUSED|6379|127\.0\.0\.1/);
      expect(serialized).not.toMatch(/ssl3_get_record|wrong version/);
    }
  });

  it("still refuses to match a refusal that was reworded", async () => {
    // The safe direction, asserted rather than assumed. If someone rewords
    // `classifyPinnedTransportError`, the detail stops matching and degrades to
    // the uniform message — it does not start leaking.
    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    const reworded =
      'Refusing to connect to "redirector.example.test" because it is not publicly routable.';
    const redacted = loaded.redact(socketFailureEnvelope(reworded));

    expect(redacted.connection.detail).not.toBe(reworded);
  });
});

/**
 * MJ-001: every answer a hosted doctor run received is reported through an
 * allowlisted projection — status, bounded status text, allowlisted headers
 * and validated protocol fields — with the body omitted. The fixtures put
 * `UNEXPECTED_MARKER_*` strings in every place an answer can carry data that
 * is not on the allowlist; none of them may appear anywhere in the result.
 */
describe("hosted doctor answer projection", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  const MARKER = /UNEXPECTED_MARKER/;

  async function hostedRedactor() {
    const loaded = await loadRedactor(true);
    restore = loaded.restore;
    return loaded.redact;
  }

  /** A doctor result in the shape `runServerDoctor` returns. */
  function doctorResult(parts: {
    attempts: ProbeHttpAttempt[];
    probe?: Record<string, unknown>;
    connection?: { status: string; detail: string };
    checks?: Record<string, { status: string; detail: string }>;
    error?: unknown;
    initInfo?: unknown;
    capabilities?: unknown;
    /** `tools`, `toolsMetadata`, `resources`, ... as the SDK collected them. */
    lists?: Record<string, unknown>;
  }) {
    return {
      target: { kind: "http", scope: "hosted", label: "Fixture" },
      generatedAt: "2026-09-25T00:00:00.000Z",
      status: "ready",
      probe: {
        url: "https://mcp.example.test/mcp",
        protocolVersion: "2025-11-25",
        status: "ready",
        transport: { selected: "streamable-http", attempts: parts.attempts },
        oauth: { required: false, optional: false, registrationStrategies: [] },
        ...parts.probe,
      },
      connection: parts.connection ?? {
        status: "connected",
        detail: "Connected and initialized successfully.",
      },
      initInfo: parts.initInfo ?? null,
      capabilities: parts.capabilities ?? null,
      tools: [] as unknown[],
      toolsMetadata: {} as Record<string, unknown>,
      resources: [] as unknown[],
      resourceTemplates: [] as unknown[],
      prompts: [] as unknown[],
      skills: [] as unknown[],
      ...parts.lists,
      checks: {
        probe: {
          status: "ok",
          detail: "HTTP initialize probe succeeded via streamable-http.",
        },
        connection: {
          status: "ok",
          detail: "Connected and initialized successfully.",
        },
        ...parts.checks,
      },
      error: parts.error ?? null,
    };
  }

  function metadataAttempt(
    name: "resource_metadata" | "authorization_server_metadata",
    url: string,
    body: unknown,
  ): ProbeHttpAttempt {
    const attempt = answeredAttempt(
      url,
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body,
        contentType: "application/json",
      },
      3,
    );
    attempt.name = name;
    attempt.request.method = "GET";
    return attempt;
  }

  const FLAGS = {
    tools: true,
    resources: false,
    prompts: false,
    logging: true,
    completions: false,
    tasks: false,
    skills: true,
  };
  /** The recognized part of the same capabilities, in their MCP shape. */
  const RECOGNIZED_CAPABILITIES = {
    tools: { listChanged: true },
    logging: {},
    extensions: { "io.modelcontextprotocol/skills": {} },
  };

  it("projects a valid initialize answer and drops its unknown and nested fields", async () => {
    const redact = await hostedRedactor();
    const serverCapabilities = {
      tools: { listChanged: true, extra: "UNEXPECTED_MARKER_3" },
      logging: {},
      experimental: { nested: { deep: "UNEXPECTED_MARKER_4" } },
      extensions: {
        "io.modelcontextprotocol/skills": { note: "UNEXPECTED_MARKER_14" },
      },
    };
    const serverInfo = {
      name: "fixture-server",
      version: "1.2.3",
      title: "Fixture Server",
      extra: "UNEXPECTED_MARKER_5",
    };
    const result = doctorResult({
      attempts: [
        answeredAttempt(
          "https://mcp.example.test/mcp",
          {
            status: 200,
            statusText: "OK",
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "session-1",
              "x-extra": "UNEXPECTED_MARKER_1",
              "set-cookie": "sid=UNEXPECTED_MARKER_2",
            },
            contentType: "application/json",
            body: {
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: serverCapabilities,
                serverInfo,
                instructions: "UNEXPECTED_MARKER_6",
                extra: { nested: ["UNEXPECTED_MARKER_7"] },
              },
            },
          },
          9,
        ),
      ],
      probe: {
        initialize: {
          protocolVersion: "2025-06-18",
          serverInfo,
          capabilities: serverCapabilities,
          contentType: "application/json",
        },
      },
      initInfo: {
        protocolVersion: "2025-06-18",
        transport: "streamable-http",
        serverCapabilities,
        serverVersion: serverInfo,
        instructions: "UNEXPECTED_MARKER_6",
        clientCapabilities: { elicitation: {} },
      },
      capabilities: serverCapabilities,
    });

    const redacted = redact(result) as any;

    const identity = {
      name: "fixture-server",
      version: "1.2.3",
      title: "Fixture Server",
    };
    const attempt = redacted.probe.transport.attempts[0];
    expect(attempt.response).toEqual({
      status: 200,
      statusText: "OK",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      },
      contentType: "application/json",
      bodyOmitted: true,
      projection: {
        kind: "initialize_result",
        protocolVersion: "2025-06-18",
        serverInfo: identity,
        capabilities: FLAGS,
      },
    });
    expect(attempt.durationMs).toBe(9);
    expect(redacted.probe.initialize).toEqual({
      protocolVersion: "2025-06-18",
      serverInfo: identity,
      capabilities: RECOGNIZED_CAPABILITIES,
      contentType: "application/json",
    });
    expect(redacted.initInfo).toEqual({
      protocolVersion: "2025-06-18",
      transport: "streamable-http",
      serverCapabilities: RECOGNIZED_CAPABILITIES,
      serverVersion: identity,
      clientCapabilities: { elicitation: {} },
    });
    expect(redacted.capabilities).toEqual(RECOGNIZED_CAPABILITIES);
    expect(JSON.stringify(redacted)).not.toMatch(MARKER);
  });

  it("omits arbitrary HTML and JSON bodies and projects nothing from them", async () => {
    const redact = await hostedRedactor();
    const bodies: unknown[] = [
      "<html><body>UNEXPECTED_MARKER_1</body></html>",
      { jsonrpc: "2.0", payload: "UNEXPECTED_MARKER_2" },
      { jsonrpc: "2.0", id: 1, result: { anything: "UNEXPECTED_MARKER_3" } },
      { arbitrary: { nested: ["UNEXPECTED_MARKER_4"] } },
      ["UNEXPECTED_MARKER_5"],
    ];

    for (const body of bodies) {
      const result = doctorResult({
        attempts: [
          answeredAttempt(
            "https://mcp.example.test/mcp",
            {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "text/html" },
              contentType: "text/html",
              body,
            },
            4,
          ),
        ],
        probe: {
          status: "reachable",
          error:
            "Server responded to initialize but did not return a recognizable MCP initialize result.",
        },
      });

      const redacted = redact(result) as any;
      const response = redacted.probe.transport.attempts[0].response;
      expect(response).not.toHaveProperty("body");
      expect(response).not.toHaveProperty("projection");
      expect(response.bodyOmitted).toBe(true);
      expect(redacted.probe.error).toBe(
        "Server responded to initialize but did not return a recognizable MCP initialize result.",
      );
      expect(JSON.stringify(redacted)).not.toMatch(MARKER);
    }
  });

  it("reduces a JSON-RPC error answer to its code and a fixed message", async () => {
    const redact = await hostedRedactor();
    const result = doctorResult({
      attempts: [
        answeredAttempt(
          "https://mcp.example.test/mcp",
          {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            contentType: "application/json",
            body: {
              jsonrpc: "2.0",
              id: 1,
              error: {
                code: -32602,
                message: "UNEXPECTED_MARKER_1",
                data: { nested: { value: "UNEXPECTED_MARKER_2" } },
              },
            },
          },
          5,
        ),
      ],
    });

    const redacted = redact(result) as any;
    expect(redacted.probe.transport.attempts[0].response.projection).toEqual({
      kind: "jsonrpc_error",
      code: -32602,
      message: "Invalid params",
    });
    expect(JSON.stringify(redacted)).not.toMatch(MARKER);
  });

  it("projects resource and authorization server metadata to the discovery fields", async () => {
    const redact = await hostedRedactor();
    const resourceMetadata = {
      resource: "https://mcp.example.test/mcp",
      authorization_servers: ["https://auth.example.test"],
      scopes_supported: ["read", "write"],
      resource_name: "UNEXPECTED_MARKER_1",
      extra: { nested: "UNEXPECTED_MARKER_2" },
    };
    const authorizationServerMetadata = {
      issuer: "https://auth.example.test",
      authorization_endpoint: "https://auth.example.test/authorize",
      token_endpoint: "https://auth.example.test/token",
      registration_endpoint: "https://auth.example.test/register",
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      service_documentation: "https://docs.example.test/UNEXPECTED_MARKER_3",
      extra: "UNEXPECTED_MARKER_4",
      nested: { list: ["UNEXPECTED_MARKER_5"] },
    };
    const challenge = answeredAttempt(
      "https://mcp.example.test/mcp",
      {
        status: 401,
        statusText: "Unauthorized",
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
          "x-extra": "UNEXPECTED_MARKER_6",
        },
        contentType: "application/json",
        body: { error: "UNEXPECTED_MARKER_7" },
      },
      6,
    );
    const prmUrl =
      "https://mcp.example.test/.well-known/oauth-protected-resource/mcp";
    const asmUrl =
      "https://auth.example.test/.well-known/oauth-authorization-server";
    const result = doctorResult({
      attempts: [
        challenge,
        metadataAttempt("resource_metadata", prmUrl, resourceMetadata),
        metadataAttempt(
          "authorization_server_metadata",
          asmUrl,
          authorizationServerMetadata,
        ),
      ],
      probe: {
        status: "oauth_required",
        oauth: {
          required: true,
          optional: false,
          wwwAuthenticate: `Bearer resource_metadata="${prmUrl}"`,
          resourceMetadataUrl: prmUrl,
          resourceMetadata,
          authorizationServerMetadataUrl: asmUrl,
          authorizationServerMetadata,
          registrationStrategies: ["preregistered", "dcr", "cimd"],
        },
      },
      connection: {
        status: "skipped",
        detail: "Server requires OAuth before a connection can be established.",
      },
      checks: {
        probe: {
          status: "error",
          detail: "Server requires OAuth before it can be connected.",
        },
      },
      error: {
        code: "OAUTH_REQUIRED",
        message:
          "Server requires OAuth before it can be connected. Run an OAuth login flow first.",
        details: {
          registrationStrategies: ["preregistered", "dcr", "cimd"],
          authorizationServerMetadataUrl: asmUrl,
          resourceMetadataUrl: prmUrl,
        },
      },
    });

    const redacted = redact(result) as any;

    const projectedResource = {
      resource: "https://mcp.example.test/mcp",
      authorization_servers: ["https://auth.example.test"],
      scopes_supported: ["read", "write"],
    };
    const projectedServer = {
      issuer: "https://auth.example.test",
      authorization_endpoint: "https://auth.example.test/authorize",
      token_endpoint: "https://auth.example.test/token",
      registration_endpoint: "https://auth.example.test/register",
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    };
    const [answer, prm, asm] = redacted.probe.transport.attempts;
    expect(answer.response.headers).toEqual({
      "www-authenticate": `Bearer resource_metadata="${prmUrl}"`,
    });
    expect(prm.response.projection).toEqual({
      kind: "resource_metadata",
      ...projectedResource,
    });
    expect(asm.response.projection).toEqual({
      kind: "authorization_server_metadata",
      ...projectedServer,
    });
    expect(redacted.probe.oauth).toEqual({
      required: true,
      optional: false,
      wwwAuthenticate: `Bearer resource_metadata="${prmUrl}"`,
      resourceMetadataUrl: prmUrl,
      resourceMetadata: projectedResource,
      authorizationServerMetadataUrl: asmUrl,
      authorizationServerMetadata: projectedServer,
      registrationStrategies: ["preregistered", "dcr", "cimd"],
    });
    expect(redacted.error).toEqual({
      code: "OAUTH_REQUIRED",
      message:
        "Server requires OAuth before it can be connected. Run an OAuth login flow first.",
      details: {
        registrationStrategies: ["preregistered", "dcr", "cimd"],
        authorizationServerMetadataUrl: asmUrl,
        resourceMetadataUrl: prmUrl,
      },
    });
    expect(redacted.checks.probe).toEqual({
      status: "error",
      detail: "Server requires OAuth before it can be connected.",
    });
    expect(JSON.stringify(redacted)).not.toMatch(MARKER);
  });

  it("bounds oversized values and omits a projection over its size budget", async () => {
    const redact = await hostedRedactor();
    const longTokens = () =>
      Array.from(
        { length: 32 },
        (_, index) => `${String(index).padStart(3, "0")}${"t".repeat(125)}`,
      );
    const LONG_CHALLENGE = "a".repeat(4000);
    const scopes = Array.from({ length: 100 }, (_, index) =>
      index === 50 ? "UNEXPECTED_MARKER_1" : `scope${index}`,
    );
    const result = doctorResult({
      attempts: [
        answeredAttempt(
          "https://mcp.example.test/mcp",
          {
            status: 200,
            statusText: `Custom ${"x".repeat(80)}UNEXPECTED_MARKER_2`,
            headers: {
              "content-type": "application/json",
              "www-authenticate": `Bearer ${LONG_CHALLENGE}UNEXPECTED_MARKER_3`,
            },
            contentType: "application/json",
            body: {
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: {
                  name: `${"n".repeat(500)}UNEXPECTED_MARKER_4`,
                  version: "1.0.0",
                },
              },
            },
          },
          7,
        ),
        metadataAttempt(
          "resource_metadata",
          "https://mcp.example.test/.well-known/oauth-protected-resource",
          {
            resource: "https://mcp.example.test/mcp",
            scopes_supported: scopes,
          },
        ),
        metadataAttempt(
          "authorization_server_metadata",
          "https://auth.example.test/.well-known/oauth-authorization-server",
          {
            issuer: "https://auth.example.test",
            scopes_supported: longTokens(),
            response_types_supported: longTokens(),
            grant_types_supported: longTokens(),
            code_challenge_methods_supported: longTokens(),
            token_endpoint_auth_methods_supported: longTokens(),
          },
        ),
      ],
    });

    const redacted = redact(result) as any;
    const [initialize, prm, asm] = redacted.probe.transport.attempts;
    expect(initialize.response.statusText.length).toBeLessThanOrEqual(64);
    expect(
      initialize.response.headers["www-authenticate"].length,
    ).toBeLessThanOrEqual(2048);
    expect(
      initialize.response.projection.serverInfo.name.length,
    ).toBeLessThanOrEqual(128);
    expect(prm.response.projection.scopes_supported).toHaveLength(32);
    expect(asm.response.bodyOmitted).toBe(true);
    expect(asm.response).not.toHaveProperty("projection");
    expect(JSON.stringify(redacted)).not.toMatch(MARKER);
  });

  it("keeps SDK summary wording and replaces text that quotes an answer", async () => {
    const redact = await hostedRedactor();
    class FixtureHttpError extends Error {
      code = "CLIENT_HTTP_NOT_IMPLEMENTED";
      data: Record<string, unknown>;
      constructor(text: string) {
        super(`Error POSTing to endpoint: ${text}`);
        this.name = "FixtureHttpError";
        this.data = { status: 500, statusText: "Internal Server Error", text };
      }
    }
    const listFailure = new FixtureHttpError(
      "<html>UNEXPECTED_MARKER_1</html>",
    );
    const statusText = `Bad Gateway ${"y".repeat(70)}UNEXPECTED_MARKER_2`;
    const probeError = `Server responded with HTTP 502 ${statusText} to the initialize probe.`;
    const result = doctorResult({
      attempts: [
        answeredAttempt(
          "https://mcp.example.test/mcp",
          {
            status: 502,
            statusText,
            headers: {},
          },
          8,
        ),
      ],
      probe: {
        status: "error",
        error: probeError,
        oauth: {
          required: false,
          optional: false,
          registrationStrategies: [],
          discoveryError:
            '[\n  {\n    "code": "invalid_type",\n    "message": "UNEXPECTED_MARKER_3"\n  }\n]',
        },
      },
      checks: {
        probe: {
          status: "error",
          detail: probeError,
        },
        tools: { status: "error", detail: listFailure.message },
        resources: { status: "ok", detail: "0 resources discovered." },
      },
      error: listFailure,
    });

    const redacted = redact(result) as any;
    expect(redacted.probe.error).toMatch(
      /^Server responded with HTTP 502 Bad Gateway y+ to the initialize probe\.$/,
    );
    expect(redacted.checks.probe.detail).toBe(redacted.probe.error);
    expect(redacted.probe.oauth.discoveryError).toBe(
      "The protected resource metadata document did not match the expected format.",
    );
    expect(redacted.checks.tools.status).toBe("error");
    expect(redacted.checks.tools.detail).toMatch(/^Listing tools failed\./);
    expect(redacted.checks.resources).toEqual({
      status: "ok",
      detail: "0 resources discovered.",
    });
    expect(redacted.error).toEqual({
      code: "CLIENT_HTTP_NOT_IMPLEMENTED",
      message: redacted.checks.tools.detail,
    });
    expect(JSON.stringify(redacted)).not.toMatch(MARKER);
  });

  it.each([
    [
      "2 of 5 sampled skills failed verification: skill://UNEXPECTED_MARKER_40/a (UNEXPECTED_MARKER_41), skill://b (hash mismatch)",
      "2 of 5 sampled skills failed verification.",
    ],
    [
      "1 listed entry rejected as malformed: UNEXPECTED_MARKER_42",
      "1 listed entry rejected as malformed.",
    ],
  ])(
    "reports the skills check's findings by their counts only",
    async (detail, counts) => {
      const redact = await hostedRedactor();
      const result = doctorResult({
        attempts: [
          answeredAttempt(
            "https://mcp.example.test/mcp",
            { status: 200, statusText: "OK", headers: {} },
            8,
          ),
        ],
        checks: { skills: { status: "error", detail } },
      });

      const redacted = redact(result) as any;

      expect(redacted.checks.skills.detail).toBe(
        `${counts} Hosted diagnostics omit upstream error text; run the doctor locally for the full message.`,
      );
      expect(JSON.stringify(redacted)).not.toMatch(MARKER);
    },
  );

  it("projects each MCP list item field by field", async () => {
    const redact = await hostedRedactor();
    const unloadableMessage =
      "This skill generates its content per request, so there is no manifest to verify it against. MCPJam declines to load unverifiable skills.";
    const result = doctorResult({
      attempts: [],
      lists: {
        tools: [
          {
            name: "search",
            title: "Search",
            description: "Finds matching records.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
            outputSchema: { type: "object" },
            annotations: {
              title: "Search records",
              readOnlyHint: true,
              extra: "UNEXPECTED_MARKER_1",
            },
            execution: { taskSupport: "optional", note: "UNEXPECTED_MARKER_2" },
            icons: [{ src: "https://cdn.example.test/UNEXPECTED_MARKER_3" }],
            _meta: { note: "UNEXPECTED_MARKER_4" },
            extra: { nested: ["UNEXPECTED_MARKER_5"] },
          },
        ],
        toolsMetadata: { search: { note: "UNEXPECTED_MARKER_4" } },
        resources: [
          {
            uri: "file:///notes.txt",
            name: "notes",
            title: "Notes",
            description: "Team notes.",
            mimeType: "text/plain",
            size: 42,
            annotations: { audience: ["user"], note: "UNEXPECTED_MARKER_6" },
            _meta: { note: "UNEXPECTED_MARKER_7" },
            extra: "UNEXPECTED_MARKER_8",
          },
        ],
        resourceTemplates: [
          {
            uriTemplate: "file:///{path}",
            name: "file",
            description: "A file by path.",
            mimeType: "text/plain",
            _meta: { note: "UNEXPECTED_MARKER_9" },
            extra: "UNEXPECTED_MARKER_10",
          },
        ],
        prompts: [
          {
            name: "summarize",
            title: "Summarize",
            description: "Summarizes text.",
            arguments: [
              {
                name: "text",
                description: "Text to summarize.",
                required: true,
                extra: "UNEXPECTED_MARKER_11",
              },
            ],
            _meta: { note: "UNEXPECTED_MARKER_12" },
          },
        ],
        skills: [
          {
            serverId: "__cli__",
            skillUri: "skill://notes/SKILL.md",
            name: "notes",
            description: "Keeps notes.",
            frontmatter: { name: "notes", extra: "UNEXPECTED_MARKER_13" },
            resources: [
              {
                uri: "skill://notes/SKILL.md",
                digest: "sha256:UNEXPECTED_MARKER_14",
              },
            ],
            unloadable: {
              reason: "dynamic_resources",
              message: unloadableMessage,
            },
          },
        ],
      },
    });

    const redacted = redact(result) as any;

    expect(redacted.tools).toEqual([
      {
        name: "search",
        title: "Search",
        description: "Finds matching records.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        outputSchema: { type: "object" },
        annotations: { title: "Search records", readOnlyHint: true },
      },
    ]);
    expect(redacted.toolsMetadata).toEqual({});
    expect(redacted.resources).toEqual([
      {
        uri: "file:///notes.txt",
        name: "notes",
        title: "Notes",
        description: "Team notes.",
        mimeType: "text/plain",
        size: 42,
      },
    ]);
    expect(redacted.resourceTemplates).toEqual([
      {
        uriTemplate: "file:///{path}",
        name: "file",
        description: "A file by path.",
        mimeType: "text/plain",
      },
    ]);
    expect(redacted.prompts).toEqual([
      {
        name: "summarize",
        title: "Summarize",
        description: "Summarizes text.",
        arguments: [
          { name: "text", description: "Text to summarize.", required: true },
        ],
      },
    ]);
    expect(redacted.skills).toEqual([
      {
        serverId: "__cli__",
        skillUri: "skill://notes/SKILL.md",
        name: "notes",
        description: "Keeps notes.",
        resourceCount: 1,
        unloadable: { reason: "dynamic_resources", message: unloadableMessage },
      },
    ]);
    expect(redacted).not.toHaveProperty("truncated");
    expect(JSON.stringify(redacted)).not.toMatch(MARKER);
  });

  it("bounds an oversized description and omits an oversized schema with a flag", async () => {
    const redact = await hostedRedactor();
    let deep: Record<string, unknown> = { note: "UNEXPECTED_MARKER_3" };
    for (let level = 0; level < 40; level += 1) {
      deep = { type: "object", properties: { next: deep } };
    }
    const result = doctorResult({
      attempts: [],
      lists: {
        tools: [
          {
            name: "large",
            description: `${"d".repeat(6000)}UNEXPECTED_MARKER_1`,
            inputSchema: {
              type: "object",
              properties: {
                blob: {
                  type: "string",
                  description: `${"x".repeat(20_000)}UNEXPECTED_MARKER_2`,
                },
              },
            },
            outputSchema: deep,
          },
        ],
        prompts: [
          {
            name: "many-arguments",
            arguments: Array.from({ length: 40 }, (_, index) => ({
              name: index === 39 ? "UNEXPECTED_MARKER_4" : `argument${index}`,
            })),
          },
        ],
      },
    });

    const redacted = redact(result) as any;
    const [tool] = redacted.tools;
    expect(tool.description).toHaveLength(4096);
    expect(tool.descriptionTruncated).toBe(true);
    expect(tool).not.toHaveProperty("inputSchema");
    expect(tool.inputSchemaOmitted).toBe(true);
    expect(tool).not.toHaveProperty("outputSchema");
    expect(tool.outputSchemaOmitted).toBe(true);
    const [prompt] = redacted.prompts;
    expect(prompt.arguments).toHaveLength(32);
    expect(prompt.argumentsTruncated).toBe(true);
    expect(JSON.stringify(redacted)).not.toMatch(MARKER);
  });

  it("caps each list and records what it did not return", async () => {
    const redact = await hostedRedactor();
    const tools = Array.from({ length: 600 }, (_, index) => ({
      name: index >= 500 ? `UNEXPECTED_MARKER_${index}` : `tool${index}`,
      inputSchema: { type: "object" },
    }));
    const result = doctorResult({
      attempts: [],
      lists: {
        tools,
        resources: [
          { uri: "file:///kept.txt", name: "kept" },
          { name: "UNEXPECTED_MARKER_1", description: "Has no URI." },
        ],
      },
    });

    const redacted = redact(result) as any;
    expect(redacted.tools).toHaveLength(500);
    expect(redacted.resources).toEqual([
      { uri: "file:///kept.txt", name: "kept" },
    ]);
    expect(redacted.truncated).toEqual({
      tools: { returned: 500, omitted: 100 },
      resources: { returned: 1, omitted: 1 },
    });
    expect(JSON.stringify(redacted)).not.toMatch(MARKER);
  });

  it("holds the list section to its size budget without crowding out small lists", async () => {
    const redact = await hostedRedactor();
    const schema = {
      type: "object",
      properties: {
        value: { type: "string", description: "s".repeat(15_000) },
      },
    };
    const tools = Array.from({ length: 400 }, (_, index) => ({
      name: `tool${index}`,
      inputSchema: schema,
    }));
    const prompts = Array.from({ length: 20 }, (_, index) => ({
      name: `prompt${index}`,
    }));
    const result = doctorResult({ attempts: [], lists: { tools, prompts } });

    const redacted = redact(result) as any;
    const listBytes = Buffer.byteLength(
      JSON.stringify([redacted.tools, redacted.prompts]),
      "utf8",
    );
    expect(listBytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 4096);
    expect(redacted.tools.length).toBeGreaterThan(0);
    expect(redacted.tools.length).toBeLessThan(400);
    expect(redacted.truncated.tools).toEqual({
      returned: redacted.tools.length,
      omitted: 400 - redacted.tools.length,
    });
    expect(redacted.prompts).toHaveLength(20);
    expect(redacted.truncated).not.toHaveProperty("prompts");
  });

  it("reports request header names but only protocol header values", async () => {
    const redact = await hostedRedactor();
    const attempt = answeredAttempt(
      "https://mcp.example.test/mcp",
      { status: 200, statusText: "OK", headers: {} },
      3,
    );
    attempt.request.headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      Authorization: "Bearer UNEXPECTED_MARKER_1",
      Cookie: "sid=UNEXPECTED_MARKER_2",
      "X-Tenant-Context": "UNEXPECTED_MARKER_3",
    };

    const redacted = redact(doctorResult({ attempts: [attempt] })) as any;
    expect(redacted.probe.transport.attempts[0].request.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      Authorization: "<redacted>",
      Cookie: "<redacted>",
      "X-Tenant-Context": "<redacted>",
    });
    expect(JSON.stringify(redacted)).not.toMatch(MARKER);
  });

  it("returns the local result untouched", async () => {
    const loaded = await loadRedactor(false);
    restore = loaded.restore;

    const body = { jsonrpc: "2.0", payload: "UNEXPECTED_MARKER_1" };
    const tool = {
      name: "local-tool",
      _meta: { note: "UNEXPECTED_MARKER_2" },
      extra: "UNEXPECTED_MARKER_3",
    };
    const result = doctorResult({
      attempts: [
        answeredAttempt(
          "http://localhost:3000/mcp",
          { status: 200, statusText: "OK", headers: {}, body },
          2,
        ),
      ],
      lists: {
        tools: [tool],
        toolsMetadata: { "local-tool": tool._meta },
      },
    });

    const redacted = loaded.redact(result);
    expect(redacted).toBe(result);
    expect(redacted.probe.transport.attempts[0].response?.body).toBe(body);
    expect(redacted.tools[0]).toBe(tool);
    expect(redacted.toolsMetadata).toEqual({ "local-tool": tool._meta });
  });
});

describe("hosted connection failure logs", () => {
  it("keeps frame envelopes, status lines and header names only", async () => {
    const { projectHostedConnectFailureLogs } =
      await import("../hosted-connect-failure.js");
    const projected = projectHostedConnectFailureLogs({
      _rpcLogs: [
        {
          eventId: "event-1",
          serverId: "srv_1",
          serverName: "Fixture",
          direction: "receive",
          timestamp: "2026-09-25T00:00:00.000Z",
          message: {
            jsonrpc: "2.0",
            id: 0,
            result: { anything: "UNEXPECTED_MARKER_1" },
          },
        },
        {
          eventId: "event-3",
          serverId: "srv_1",
          serverName: "Fixture",
          direction: "send",
          timestamp: "2026-09-25T00:00:00.000Z",
          message: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: { cursor: "UNEXPECTED_MARKER_6" },
          },
        },
      ],
      _httpLogs: [
        {
          eventId: "event-2",
          serverId: "srv_1",
          serverName: "Fixture",
          timestamp: "2026-09-25T00:00:00.000Z",
          exchange: {
            serverId: "srv_1",
            request: {
              method: "POST",
              url: "https://mcp.example.test/mcp",
              headers: {
                "content-type": "application/json",
                "x-tenant-context": "UNEXPECTED_MARKER_2",
                authorization: "Bearer UNEXPECTED_MARKER_3",
              },
            },
            response: {
              status: 500,
              statusText: `Internal ${"x".repeat(80)}UNEXPECTED_MARKER_4`,
              headers: {
                "content-type": "text/html",
                "x-extra": "UNEXPECTED_MARKER_5",
              },
            },
            durationMs: 4,
            bodyValues: {
              method: "resources/read",
              name: "UNEXPECTED_MARKER_7",
              protocolVersion: "2025-06-18",
              extra: "UNEXPECTED_MARKER_8",
            },
          },
        },
      ],
    }) as any;

    expect(projected._rpcLogs[0].message).toEqual({
      jsonrpc: "2.0",
      id: 0,
      contentOmitted: true,
    });
    expect(projected._rpcLogs[1]).toMatchObject({
      direction: "send",
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        contentOmitted: true,
      },
    });
    expect(projected._rpcLogs[1].message).not.toHaveProperty("params");
    const exchange = projected._httpLogs[0].exchange;
    expect(exchange.bodyValues).toEqual({
      method: "resources/read",
      protocolVersion: "2025-06-18",
    });
    expect(exchange.request.headers).toEqual({
      "content-type": "application/json",
      "x-tenant-context": "<redacted>",
      authorization: "<redacted>",
    });
    expect(exchange.response.headers).toEqual({ "content-type": "text/html" });
    expect(exchange.response.statusText.length).toBeLessThanOrEqual(64);
    expect(JSON.stringify(projected)).not.toMatch(/UNEXPECTED_MARKER/);
  });

  it("bounds each log array by count and size and counts what it left out", async () => {
    const { projectHostedConnectFailureLogs } =
      await import("../hosted-connect-failure.js");
    const { MAX_LOG_ARRAY_BYTES } =
      await import("../hosted-upstream-projection.js");
    const identity = (index: number) => ({
      eventId: `event-${index}`,
      serverId: "srv_1",
      serverName: "Fixture",
      timestamp: "2026-09-25T00:00:00.000Z",
    });
    const headers = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `x-header-${index}-${"h".repeat(100)}`,
        "value",
      ]),
    );

    const projected = projectHostedConnectFailureLogs({
      _rpcLogs: Array.from({ length: 1000 }, (_, index) => ({
        ...identity(index),
        direction: "receive",
        message: { jsonrpc: "2.0", method: "notifications/message" },
      })),
      _httpLogs: Array.from({ length: 150 }, (_, index) => ({
        ...identity(index),
        exchange: {
          serverId: "srv_1",
          request: {
            method: "POST",
            url: "https://mcp.example.test/mcp",
            headers,
          },
          response: { status: 200, statusText: "OK", headers: {} },
          durationMs: 1,
        },
      })),
    }) as any;

    expect(projected._rpcLogs).toHaveLength(200);
    expect(projected._rpcLogs[99].eventId).toBe("event-99");
    expect(projected._rpcLogs[100].eventId).toBe("event-900");
    expect(projected._rpcLogsOmitted).toBe(800);
    expect(
      Buffer.byteLength(JSON.stringify(projected._httpLogs), "utf8"),
    ).toBeLessThanOrEqual(MAX_LOG_ARRAY_BYTES);
    expect(projected._httpLogs.length + projected._httpLogsOmitted).toBe(150);
    expect(projected._httpLogsOmitted).toBeGreaterThan(0);
  });

  it("counts the array's own delimiters against its size bound", async () => {
    const { projectHostedConnectFailureLogs } =
      await import("../hosted-connect-failure.js");
    const { MAX_LOG_ARRAY_BYTES } =
      await import("../hosted-upstream-projection.js");
    const event = (serverName: string) => ({
      eventId: "event",
      serverId: "srv_1",
      serverName,
      timestamp: "2026-09-25T00:00:00.000Z",
      direction: "receive",
      message: { jsonrpc: "2.0", method: "notifications/message" },
    });
    const encodedSize = (serverName: string) =>
      Buffer.byteLength(
        JSON.stringify(
          (
            projectHostedConnectFailureLogs({
              _rpcLogs: [event(serverName)],
            }) as any
          )._rpcLogs[0],
        ),
        "utf8",
      );
    const sized = (bytes: number) => event("n".repeat(bytes - encodedSize("")));

    for (const events of [
      [sized(MAX_LOG_ARRAY_BYTES)],
      [sized(MAX_LOG_ARRAY_BYTES / 2), sized(MAX_LOG_ARRAY_BYTES / 2)],
    ]) {
      const projected = projectHostedConnectFailureLogs({
        _rpcLogs: events,
      }) as any;
      expect(
        Buffer.byteLength(JSON.stringify(projected._rpcLogs), "utf8"),
      ).toBeLessThanOrEqual(MAX_LOG_ARRAY_BYTES);
      expect(projected._rpcLogs.length + projected._rpcLogsOmitted).toBe(
        events.length,
      );
    }
  });

  it("keeps a failure's flags and scope challenge within their projection", async () => {
    const { projectHostedConnectFailureDetails } =
      await import("../hosted-connect-failure.js");

    expect(
      projectHostedConnectFailureDetails({
        upstreamAuthRequired: true,
        oauthRequired: "UNEXPECTED_MARKER_1",
        insufficientScope: {
          requiredScope: "tools:read  tools:write\u0000UNEXPECTED_MARKER_2",
          resourceMetadataUrl:
            "https://mcp.example.test/.well-known/oauth-protected-resource",
          errorDescription: "UNEXPECTED_MARKER_3",
        },
        extra: "UNEXPECTED_MARKER_4",
      }),
    ).toEqual({
      upstreamAuthRequired: true,
      insufficientScope: {
        requiredScope: "tools:read",
        resourceMetadataUrl:
          "https://mcp.example.test/.well-known/oauth-protected-resource",
      },
    });
    expect(
      projectHostedConnectFailureDetails({
        insufficientScope: {
          resourceMetadataUrl: "javascript:UNEXPECTED_MARKER_5",
          errorDescription: "UNEXPECTED_MARKER_6",
        },
      }),
    ).toBeUndefined();
    expect(projectHostedConnectFailureDetails(undefined)).toBeUndefined();
  });

  it("does not attribute an earlier answer's status to a later failed exchange", async () => {
    const { describeHostedConnectFailure } = await import(
      "../hosted-connect-failure.js"
    );
    const exchangeEvent = (
      response: { status: number; statusText: string } | undefined,
    ) => ({
      eventId: "event",
      serverId: "srv_1",
      serverName: "Fixture",
      timestamp: "2026-09-25T00:00:00.000Z",
      exchange: {
        serverId: "srv_1",
        request: { method: "POST", url: "https://mcp.example.test/mcp" },
        ...(response ? { response } : { transportError: "fetch failed" }),
        durationMs: 4,
      },
    });

    // initialize answered 200; the next request's fetch rejected. The failure
    // is the transport's, not the 200's.
    const failure = describeHostedConnectFailure(new Error("fetch failed"), {
      _httpLogs: [
        exchangeEvent({ status: 200, statusText: "OK" }),
        exchangeEvent(undefined),
      ],
    });
    expect(failure.message).not.toContain("200");

    // A 200 that IS the last answer is still reported as not-MCP.
    const answered = describeHostedConnectFailure(new Error("not mcp"), {
      _httpLogs: [exchangeEvent({ status: 200, statusText: "OK" })],
    });
    expect(answered.message).toContain("200");
    expect(answered.message).toContain("not with a valid MCP response");
  });

  it("reads an HTTP status only where the transport put one", async () => {
    const { describeHostedConnectFailure } =
      await import("../hosted-connect-failure.js");
    const logs = {
      _httpLogs: [
        {
          eventId: "event",
          serverId: "srv_1",
          serverName: "Fixture",
          timestamp: "2026-09-25T00:00:00.000Z",
          exchange: {
            serverId: "srv_1",
            request: { method: "POST", url: "https://mcp.example.test/mcp" },
            response: { status: 200, statusText: "OK" },
            durationMs: 4,
          },
        },
      ],
    };
    const named = (name: string, fields: Record<string, unknown>) =>
      Object.assign(new Error("failed"), { name, ...fields });
    const protocolError = named("ProtocolError", {
      code: 401,
      data: {
        cause: { status: 418, statusText: "UNEXPECTED_MARKER_1" },
      },
    });
    class StreamableHTTPError extends Error {
      constructor(readonly code: number) {
        super("failed");
      }
    }

    for (const error of [
      named("McpError", { code: 503 }),
      protocolError,
      named("MCPAuthError", { statusCode: 401, cause: protocolError }),
    ]) {
      const failure = describeHostedConnectFailure(error, logs);
      expect(failure.message).toBe(
        "The MCP server responded with HTTP 200 OK, but not with a valid MCP response.",
      );
    }
    expect(
      describeHostedConnectFailure(new StreamableHTTPError(502), logs).message,
    ).toBe("The MCP server responded with HTTP 502.");
    expect(
      describeHostedConnectFailure(
        named("SdkError", {
          code: "ERA_NEGOTIATION_FAILED",
          data: {
            cause: named("SdkHttpError", {
              status: 503,
              statusText: "Service Unavailable",
            }),
          },
        }),
        logs,
      ).message,
    ).toBe("The MCP server responded with HTTP 503 Service Unavailable.");
    expect(
      describeHostedConnectFailure(
        named("MCPAuthError", {
          statusCode: 401,
          cause: named("UnauthorizedError", {}),
        }),
        logs,
      ).message,
    ).toBe("The MCP server responded with HTTP 401.");
  });
});
