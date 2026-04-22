import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { createServer } from "@/test/factories";
import { useExploreCasesPrefetchOnConnect } from "../use-explore-cases-prefetch-on-connect";

describe("useExploreCasesPrefetchOnConnect", () => {
  it("does not create or generate eval suites as a side effect of connecting a server", () => {
    const connectedServer = createServer({
      name: "server-a",
      connectionStatus: "connected",
    });

    const { rerender, result } = renderHook(
      ({
        workspaceId,
        hostedServerId,
      }: {
        workspaceId: string | null;
        hostedServerId?: string | null;
      }) =>
        useExploreCasesPrefetchOnConnect(
          workspaceId,
          connectedServer,
          hostedServerId,
        ),
      {
        initialProps: {
          workspaceId: "ws-1",
          hostedServerId: "convex-server-id",
        },
      },
    );

    rerender({
      workspaceId: "ws-1",
      hostedServerId: "convex-server-id",
    });

    expect(result.current).toBeUndefined();
  });
});
