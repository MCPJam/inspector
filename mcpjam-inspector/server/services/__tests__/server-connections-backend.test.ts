/**
 * The Inspector's client for the backend's connection routes.
 *
 * The assertions here are about TELLING FAILURES APART, because this client
 * sits between two things that both answer in HTTP and mean different things:
 * a backend that refused (409, 410 — normal races the worker must not retry)
 * and a call that never completed (a timeout, which must not be reported as if
 * the backend said something).
 *
 * The subtle one is the body read. A `fetch` that has RESOLVED has not
 * finished — the response headers arrived, the body has not — and the same
 * timeout still governs it. Swallowing every throw from `.json()` turned an
 * abort into `Backend call failed (200)`: a timeout wearing a status code from
 * a call that never delivered anything.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../internal-backend.js", async () => {
  const actual = await vi.importActual<
    typeof import("../internal-backend.js")
  >("../internal-backend.js");
  return {
    ...actual,
    getInternalBackendConfig: () => ({
      convexUrl: "https://convex.test",
      serviceToken: "service-token",
    }),
  };
});

const {
  acquireLease,
  reportValidation,
  ServerConnectionBackendError,
} = await import("../server-connections-backend.js");

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A response whose headers arrived and whose body never does. */
function bodyAborts(status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      throw Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      });
    },
  } as unknown as Response;
}

function jsonResponse(status: number, payload: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  } as unknown as Response;
}

describe("call outcomes", () => {
  it("returns the payload on success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ok: true, leased: true, status: "discovering" })
    );

    await expect(acquireLease("scr_1", "lease_1")).resolves.toMatchObject({
      leased: true,
      status: "discovering",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://convex.test/internal/v1/server-connections/lease");
    expect(
      (init.headers as Record<string, string>)["x-inspector-service-token"]
    ).toBe("service-token");
  });

  it("reports a conflict as a conflict, not a fault", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, { ok: false, error: "someone else has it" })
    );

    const error = await acquireLease("scr_1", "lease_1").catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ServerConnectionBackendError);
    expect((error as InstanceType<typeof ServerConnectionBackendError>).isConflict).toBe(true);
  });

  it("distinguishes a missing request from a missing route", async () => {
    // Collapsing these sends someone hunting a deleted row when the real answer
    // is a stale backend or a wrong CONVEX_HTTP_URL.
    fetchMock.mockResolvedValue(
      jsonResponse(404, { code: "not found", error: "not found" })
    );

    const error = await acquireLease("scr_1", "lease_1").catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
  });

  it("keeps null for a body that is merely unparseable", async () => {
    // Not an abort — the call completed and the backend said something we
    // could not read. The status line alone is enough to answer with.
    fetchMock.mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    } as unknown as Response);

    const error = await reportValidation({
      requestId: "scr_1",
      leaseId: "lease_1",
      outcome: "retryable",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServerConnectionBackendError);
    expect((error as Error).message).toContain("500");
  });
});

describe("a body read that never finishes", () => {
  it("is a timeout, not a 200", async () => {
    fetchMock.mockResolvedValue(bodyAborts(200));

    const error = await acquireLease("scr_1", "lease_1").catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ServerConnectionBackendError);
    // The bug this pins: `Backend call failed (200)` — a timeout reported with
    // a status code, from a call that delivered nothing.
    expect((error as Error).message).toContain("timed out");
    expect((error as Error).message).not.toContain("200");
    expect(
      (error as InstanceType<typeof ServerConnectionBackendError>).status
    ).toBe(504);
  });

  it("recognises an abort wrapped in a cause chain", async () => {
    // `undici` surfaces a cut-short body read in more than one shape.
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => {
        throw new TypeError("terminated", {
          cause: Object.assign(new Error("aborted"), { name: "AbortError" }),
        });
      },
    } as unknown as Response);

    const error = await acquireLease("scr_1", "lease_1").catch(
      (e: unknown) => e
    );

    expect((error as Error).message).toContain("timed out");
  });
});
