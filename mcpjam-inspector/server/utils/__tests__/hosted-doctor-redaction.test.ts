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

type DoctorEnvelope = {
  probe: {
    status?: string;
    /** The probe's own top-level error — see the note in the redactor. */
    error?: string;
    transport: {
      attempts: Array<{
        request: { url: string };
        response?: { status: number; headers: Record<string, string>; body?: unknown };
        error?: string;
      }>;
    };
  } | null;
  connection: { status: string; detail: string };
  checks: Record<string, { status: string; detail: string }>;
  error: { code: string; message: string } | null;
};

/** A doctor result whose only outcome was a socket error — no HTTP response. */
function socketFailureEnvelope(socketError: string): DoctorEnvelope {
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
          {
            request: { url: "https://mcp.example.test/mcp" },
            error: socketError,
          },
        ],
      },
    },
    connection: { status: "error", detail: socketError },
    checks: {
      probe: { status: "error", detail: `HTTP probe failed: ${socketError}` },
      connection: { status: "error", detail: socketError },
      tools: { status: "skipped", detail: "Tools were not collected." },
    },
    error: { code: "SERVER_UNREACHABLE", message: socketError },
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

    const closed = loaded.redact(socketFailureEnvelope(CLOSED_PORT));
    const open = loaded.redact(socketFailureEnvelope(OPEN_CLEARTEXT_PORT));

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

  it("passes through detail once the target answered as a public host", async () => {
    // A target that produced an HTTP response is a public responder, so its
    // diagnostic is the product rather than an oracle — and an MCP-level
    // failure against it is exactly what the debugger exists to show.
    const loaded = await loadRedactor(true);
    restore = loaded.restore;

    const envelope = socketFailureEnvelope("initialize failed: -32600");
    envelope.probe!.transport.attempts[0].response = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { jsonrpc: "2.0", error: { code: -32600 } },
    };

    const redacted = loaded.redact(envelope);
    expect(redacted.connection.detail).toBe("initialize failed: -32600");
    expect(redacted.probe!.transport.attempts[0].response?.status).toBe(200);
  });

  it("does nothing in local mode, where the socket error is the answer", async () => {
    const loaded = await loadRedactor(false);
    restore = loaded.restore;

    const redacted = loaded.redact(socketFailureEnvelope(CLOSED_PORT));
    expect(redacted.connection.detail).toBe(CLOSED_PORT);
    expect(redacted.error?.message).toBe(CLOSED_PORT);
  });
});
