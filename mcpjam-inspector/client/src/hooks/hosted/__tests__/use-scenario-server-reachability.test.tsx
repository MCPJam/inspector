import { StrictMode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useScenarioServerReachability } from "../use-scenario-server-reachability";

vi.mock("@/lib/apis/web/servers-api", () => ({
  validateHostedServer: vi.fn(),
}));

const { validateHostedServer } = await import("@/lib/apis/web/servers-api");
const validateMock = vi.mocked(validateHostedServer);

const SERVERS = [{ serverId: "srv_1", serverName: "Books" }];

beforeEach(() => {
  validateMock.mockReset();
});

describe("useScenarioServerReachability under StrictMode", () => {
  it("keeps a retry for the first real failure after the double-invoke abort", async () => {
    // PROBE_ATTEMPTS is 2. The sequence a healthy-but-blippy server produces
    // under StrictMode: the first call is still open when the cleanup aborts
    // it, the second hits a transient 502, the third succeeds. The abort is
    // not evidence about the server, so the 502 must still have a retry left.
    let call = 0;
    validateMock.mockImplementation((_id, _a, _b, _c, signal?: AbortSignal) => {
      call += 1;
      if (call === 1) {
        // Never settles on its own — only the StrictMode abort ends it.
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      if (call === 2) return Promise.reject(new Error("502 from the edge"));
      return Promise.resolve({ ok: true } as never);
    });

    const { result } = renderHook(
      () => useScenarioServerReachability(SERVERS, true, "session_1"),
      { wrapper: StrictMode },
    );

    await waitFor(
      () => {
        expect(result.current.srv_1).toBe("reachable");
      },
      { timeout: 5000 },
    );
    expect(call).toBe(3);
  });
});
