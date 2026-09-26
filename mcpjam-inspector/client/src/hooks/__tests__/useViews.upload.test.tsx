import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useViewMutations } from "../useViews";

const mutationNames: string[] = [];
const mockGetConvexAccessToken = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useMutation: (name: string) => {
    mutationNames.push(name);
    return vi.fn();
  },
}));

vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: () => "https://demo.convex.site",
}));

vi.mock("@/hooks/use-convex-access-token", () => ({
  useConvexAccessToken: () => mockGetConvexAccessToken,
}));

const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useViewMutations().uploadMcpViewBlob", () => {
  beforeEach(() => {
    mutationNames.length = 0;
    mockGetConvexAccessToken.mockReset().mockResolvedValue("bearer-1");
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends a view blob to the upload route and returns its storage id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, storageId: "kg2_view" }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useViewMutations());

    const body = new Blob(["<div>view</div>"], {
      type: "text/plain; charset=utf-8",
    });
    const storageId = await result.current.uploadMcpViewBlob(
      body,
      "text/plain; charset=utf-8",
    );

    expect(storageId).toBe("kg2_view");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://demo.convex.site/web/uploads/blob?purpose=mcp-app-view",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "text/plain; charset=utf-8",
      Authorization: "Bearer bearer-1",
    });
    expect(init.body).toBe(body);
    expect(mutationNames).toEqual([
      "mcpAppViews:create",
      "mcpAppViews:update",
      "mcpAppViews:remove",
    ]);
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [413, "PAYLOAD_TOO_LARGE"],
    [429, "RATE_LIMITED"],
  ])("rejects a %i with the route's code", async (status, code) => {
    global.fetch = vi.fn(async () =>
      jsonResponse(status, { ok: false, code, error: `refused: ${code}` }),
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useViewMutations());

    await expect(
      result.current.uploadMcpViewBlob("<div/>", "text/plain"),
    ).rejects.toMatchObject({
      name: "BlobUploadError",
      status,
      code,
      message: `refused: ${code}`,
    });
  });
});
