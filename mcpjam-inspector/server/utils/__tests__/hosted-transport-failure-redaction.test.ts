/**
 * MJ-001, persisted conformance: what a failed hosted dial may still say once
 * a suite has recorded it.
 *
 * The property under test is the one the SDK's report serializer breaks by
 * design — `deepJsonSafe` keeps an `Error`'s `cause` chain and its own fields —
 * so every case asserts on everything such a serializer can reach, not only on
 * `error.message`. The end-to-end half (a real run, a real stored report) is
 * `services/__tests__/conformance-run-executor-egress.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { redactHostedTransportFailures } from "../hosted-transport-failure-redaction.js";
import { HOSTED_TRANSPORT_FAILURE_DETAIL } from "../hosted-doctor-redaction.js";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
} from "../hosted-egress-guard.js";

/**
 * Everything a report serializer can reach on a thrown value: the fields
 * `deepJsonSafe` names (`name`, `message`, `code`, `statusCode`, `cause`) plus
 * every own enumerable property, recursively through `cause`.
 */
function reachable(value: unknown, depth = 0): unknown {
  if (!(value instanceof Error) || depth > 8) return value;
  const record = value as Error & Record<string, unknown>;
  return {
    name: record.name,
    message: record.message,
    code: record.code,
    statusCode: record.statusCode,
    ...Object.fromEntries(Object.entries(record)),
    cause: reachable(record.cause, depth + 1),
  };
}

/** What a conformance report could persist for the rejection of `fetchFn`. */
async function storedFor(
  fetchFn: typeof fetch,
): Promise<{ thrown: unknown; stored: string }> {
  const thrown = await fetchFn("https://target.example.test/mcp").then(
    () => undefined,
    (error: unknown) => error,
  );
  return { thrown, stored: JSON.stringify(reachable(thrown)) };
}

function rejectingWith(error: unknown): typeof fetch {
  return vi.fn(async () => {
    throw error;
  }) as unknown as typeof fetch;
}

/** A Node socket error as `node:http` raises it: message, code and address. */
function socketError(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

describe("redactHostedTransportFailures (hosted)", () => {
  it("passes a response through untouched", async () => {
    const response = new Response("body", { status: 418 });
    const wrapped = redactHostedTransportFailures(
      vi.fn(async () => response) as unknown as typeof fetch,
      { hosted: true },
    );
    await expect(wrapped("https://target.example.test/mcp")).resolves.toBe(
      response,
    );
  });

  it("keeps a refusal's verdict and drops the cause that names the resolved address", async () => {
    const refusal = new BlockedEgressTargetError(
      'Request URL hostname "internal.example.test" resolves to a private or internal address that the hosted inspector will not dial.',
      { cause: new Error("resolved address: 10.1.2.3") },
    );
    const { thrown, stored } = await storedFor(
      redactHostedTransportFailures(rejectingWith(refusal), { hosted: true }),
    );

    expect(thrown).toBeInstanceOf(BlockedEgressTargetError);
    expect((thrown as Error).message).toBe(refusal.message);
    expect((thrown as Error).cause).toBeUndefined();
    expect(stored).not.toMatch(/10\.1\.2\.3|resolved address/);
    // The guard's own object keeps its cause: that copy belongs to the logs.
    expect(refusal.cause).toBeDefined();
  });

  it("collapses open-versus-closed socket outcomes to one message", async () => {
    const outcomes = [
      socketError("connect ECONNREFUSED 203.0.113.7:6379", {
        code: "ECONNREFUSED",
        address: "203.0.113.7",
        port: 6379,
        syscall: "connect",
      }),
      socketError(
        "C0B6F9E3:error:0A00010B:SSL routines:ssl3_get_record:wrong version number",
        { code: "ERR_SSL_WRONG_VERSION_NUMBER", library: "SSL routines" },
      ),
      new TypeError("fetch failed", {
        cause: socketError("connect ETIMEDOUT 203.0.113.7:22", {
          code: "ETIMEDOUT",
        }),
      }),
      new Error("MCP server did not answer within 300000ms."),
    ];

    const stored = await Promise.all(
      outcomes.map((outcome) =>
        storedFor(
          redactHostedTransportFailures(rejectingWith(outcome), {
            hosted: true,
          }),
        ),
      ),
    );

    for (const { thrown, stored: json } of stored) {
      expect((thrown as Error).message).toBe(HOSTED_TRANSPORT_FAILURE_DETAIL);
      expect(json).not.toMatch(
        /ECONN|ETIMEDOUT|203\.0\.113\.7|6379|ssl|wrong version|did not answer|cause/i,
      );
    }
    // The point of the exercise: the outcomes are indistinguishable.
    expect(new Set(stored.map((entry) => entry.stored)).size).toBe(1);
  });

  it("collapses a resolution failure too, so a name's existence is not reported", async () => {
    const { thrown, stored } = await storedFor(
      redactHostedTransportFailures(
        rejectingWith(
          new EgressResolutionError(
            'Could not check "missing.example.test" for a safe address: getaddrinfo ENOTFOUND missing.example.test',
          ),
        ),
        { hosted: true },
      ),
    );
    expect((thrown as Error).message).toBe(HOSTED_TRANSPORT_FAILURE_DETAIL);
    expect(stored).not.toMatch(/ENOTFOUND|getaddrinfo/);
  });

  it("passes the caller's own cancellation through by name", async () => {
    const aborted = new DOMException(
      "This operation was aborted",
      "AbortError",
    );
    const timedOut = new DOMException(
      "The operation timed out",
      "TimeoutError",
    );
    for (const cancellation of [aborted, timedOut]) {
      const { thrown } = await storedFor(
        redactHostedTransportFailures(rejectingWith(cancellation), {
          hosted: true,
        }),
      );
      expect(thrown).toBe(cancellation);
    }
  });
});

describe("redactHostedTransportFailures (local)", () => {
  it("is the identity outside hosted mode, where the socket error is the answer", () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    expect(redactHostedTransportFailures(fetchFn, { hosted: false })).toBe(
      fetchFn,
    );
  });
});
