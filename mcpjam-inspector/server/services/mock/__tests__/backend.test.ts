import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({
    Authorization: `Bearer ${bearer}`,
  }),
}));

import { resolveMock } from "../backend.js";
import { MockRefusal } from "../refusal.js";

const caller = { authMethod: "workos_api_key", workosUserId: "ann" };
const input = { mockId: "mock1", caller, bearerToken: "sk_ann" };
const answer = {
  mockId: "mock1",
  projectId: "proj1",
  name: "Echo mock",
  version: 2,
  headVersion: 3,
  contentHash: "a".repeat(64),
  definition: { tools: { echo: { description: "MOCKED" } } },
  baseServerId: "real1",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
});

describe("resolveMock", () => {
  it("asks the backend as the caller, by mock id, and reads the definition", async () => {
    const fetch = vi.fn(async () => reply(answer));
    const resolved = await resolveMock(input, { fetch });
    expect(resolved).toMatchObject({ mockId: "mock1", version: 2, headVersion: 3, baseServerId: "real1" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://backend.test/web/mock/resolve");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_ann");
    expect(JSON.parse(String(init.body))).toEqual({ mockId: "mock1" });
  });

  it("remembers nothing: a second call asks again, and sees a refusal at once", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(answer))
      .mockResolvedValueOnce(reply({ code: "MOCK_FORBIDDEN", message: "no" }, 403))
      .mockResolvedValueOnce(reply(answer));
    await resolveMock(input, { fetch });
    await expect(resolveMock(input, { fetch })).rejects.toMatchObject({ kind: "forbidden" });
    await resolveMock(input, { fetch });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["MOCK_SERVERS_FLAG_OFF", 403, "flag_off"],
    ["MOCK_GUEST_REFUSED", 403, "guest"],
    ["MOCK_NOT_FOUND", 404, "not_found"],
    ["MOCK_VERSION_NOT_FOUND", 404, "not_found"],
    ["SOMETHING_NEW", 401, "unauthorized"],
    ["SOMETHING_NEW", 500, "unavailable"],
  ])("maps %s (%i) to the %s refusal", async (code, status, kind) => {
    const fetch = vi.fn(async () => reply({ code }, status));
    await expect(resolveMock(input, { fetch })).rejects.toMatchObject({ kind });
  });

  it("refuses an answer whose definition this build cannot read", async () => {
    const fetch = vi.fn(async () => reply({ ...answer, definition: { tools: { echo: { nope: 1 } } } }));
    await expect(resolveMock(input, { fetch })).rejects.toBeInstanceOf(MockRefusal);
    await expect(resolveMock(input, { fetch })).rejects.toMatchObject({ kind: "invalid_definition" });
  });

  it("is unavailable when the backend does not answer", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(resolveMock(input, { fetch })).rejects.toMatchObject({ kind: "unavailable" });
  });
});
