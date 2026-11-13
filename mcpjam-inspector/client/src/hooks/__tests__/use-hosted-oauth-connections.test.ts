import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/apis/web/oauth-connections", () => ({
  listOAuthConnections: api.list,
  OAUTH_CONNECTIONS_CHANGED: "oauth-connections-changed",
}));

import { useHostedOAuthConnections } from "../use-hosted-oauth-connections";

describe("useHostedOAuthConnections", () => {
  it("drops the rows when a reload fails, so nothing acts on accounts that may be gone", async () => {
    api.list
      .mockResolvedValueOnce({
        connections: [{ connectionId: "a", isDefault: true }],
        shared: true,
      })
      .mockRejectedValueOnce(new Error("Could not load accounts"));
    const { result } = renderHook(() =>
      useHostedOAuthConnections("project-1", "server-1"),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.connections).toHaveLength(1);

    act(() => result.current.refetch());

    await waitFor(() =>
      expect(result.current.error).toBe("Could not load accounts"),
    );
    expect(result.current.loaded).toBe(false);
    expect(result.current.connections).toEqual([]);
  });
});
