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

  it("passes through detail once the target answered and nothing dialled after it", async () => {
    // A target that produced an HTTP response is a public responder, so its
    // diagnostic is the product rather than an oracle — and an MCP-level
    // failure against it is exactly what the debugger exists to show. This is
    // the shape where that still holds: no socket was dialled after the probe,
    // so `connection` is not reporting one.
    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    const envelope = socketFailureEnvelope("initialize failed: -32600");
    envelope.probe!.transport.attempts[0] = answeredAttempt(
      "https://mcp.example.test/mcp",
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", error: { code: -32600 } },
      },
      12
    );
    envelope.connection = {
      status: "skipped",
      detail: "Server requires OAuth before a connection can be established.",
    };
    envelope.checks.connection = envelope.connection;

    const redacted = loaded.redact(envelope);
    expect(redacted.probe!.error).toBe("initialize failed: -32600");
    expect(redacted.error?.message).toBe("initialize failed: -32600");
    expect(redacted.probe!.transport.attempts[0].response?.status).toBe(200);
    expect(redacted.probe!.transport.attempts[0].durationMs).toBe(12);
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
      'Metadata pointer hostname "metadata.example.test" resolves to a private or internal address that the hosted inspector will not dial.';
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

    // The answered attempt reached a public responder, so its diagnostic is
    // still the product. The refused one is a socket outcome against whatever
    // the second transport dialled, and used to ride out on the first's
    // response.
    expect(redacted.probe!.transport.attempts[0].error).toBe(
      "initialize failed: -32600"
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
});
