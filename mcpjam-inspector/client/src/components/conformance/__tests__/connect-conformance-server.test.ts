import { describe, expect, it, vi } from "vitest";
import type { EnsureServerConnectionStatus } from "@/hooks/use-server-state";
import { createConformanceConnector } from "../connect-conformance-server";

describe("conformance connector", () => {
  it.each([
    ["reauth", "reauth"],
    ["failed", "failed"],
    ["missing", "failed"],
    ["superseded", "failed"],
    ["connected", "ready"],
  ] satisfies Array<[EnsureServerConnectionStatus, string]>)(
    "does not start another OAuth flow after forced sign-in returns %s",
    async (status, expected) => {
      const initiateOAuth = vi.fn(async () => ({ status }));
      const reconnectServerWithResult = vi.fn(async () => initiateOAuth());
      const ensureServersReady = vi.fn(async () => {
        await initiateOAuth();
        return {
          missingServerNames: [],
          readyServerNames: [],
          reauthServerNames: [],
          failedServerNames: [],
        };
      });
      const connectServer = createConformanceConnector({
        ensureServersReady,
        reconnectServerWithResult,
      });
      expect(await connectServer("bart", { signIn: true })).toBe(expected);
      expect(reconnectServerWithResult).toHaveBeenCalledWith("bart", {
        forceOAuthFlow: true,
      });
      expect(initiateOAuth).toHaveBeenCalledTimes(1);
      expect(ensureServersReady).not.toHaveBeenCalled();
    },
  );

  it("uses normal readiness checks without forcing sign-in", async () => {
    const reconnectServerWithResult = vi.fn();
    const ensureServersReady = vi.fn(async () => ({
      missingServerNames: [],
      readyServerNames: ["bart"],
      reauthServerNames: [],
      failedServerNames: [],
    }));
    const connectServer = createConformanceConnector({
      ensureServersReady,
      reconnectServerWithResult,
    });
    expect(await connectServer("bart")).toBe("ready");
    expect(ensureServersReady).toHaveBeenCalledWith(["bart"]);
    expect(reconnectServerWithResult).not.toHaveBeenCalled();
  });
});
