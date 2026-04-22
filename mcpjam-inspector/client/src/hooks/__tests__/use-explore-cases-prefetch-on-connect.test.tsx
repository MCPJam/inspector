import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { createServer } from "@/test/factories";
import { useExploreCasesPrefetchOnConnect } from "../use-explore-cases-prefetch-on-connect";

describe("useExploreCasesPrefetchOnConnect", () => {
  it("is a no-op (explore suite creation is handled by EvalsTab)", () => {
    const connectedServer = createServer({
      name: "server-a",
      connectionStatus: "connected",
    });

    const { result } = renderHook(() =>
      useExploreCasesPrefetchOnConnect(
        "ws-1",
        connectedServer,
        "convex-server-id",
      ),
    );

    expect(result.current).toBeUndefined();
  });
});
