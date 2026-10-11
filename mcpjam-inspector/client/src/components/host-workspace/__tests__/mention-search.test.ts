import { describe, expect, it, vi } from "vitest";
import { searchPluginMentions } from "../mention-search";
const provider = { projectId: "project", hostId: "host", serverId: "server" };
const token = "x".repeat(43);
function fixture() {
  const post = vi.fn(
    async (action: string, _body: unknown, _signal?: AbortSignal) =>
      new Response(
        JSON.stringify(
          action === "mentions/open"
            ? {
                mention: {
                  instanceToken: token,
                  toolName: "mentions",
                  title: "Parts",
                },
              }
            : action === "mentions/search"
            ? {
                status: "completed",
                result: {
                  content: [],
                  structuredContent: {
                    items: [
                      {
                        type: "resource",
                        resourceUri: "fixture://bolt",
                        title: "Bolt",
                      },
                    ],
                  },
                },
              }
            : { status: "closed" },
        ),
      ),
  );
  const abort = new AbortController(),
    requireLive = vi.fn(),
    approve = vi.fn(async () => true),
    cleanupError = vi.fn();
  const search = () =>
    searchPluginMentions({
      provider,
      query: "bolt",
      signal: abort.signal,
      requireLive,
      post,
      approve,
      cleanupError,
      workspaceId: "workspace",
    });
  return { post, abort, requireLive, approve, cleanupError, search };
}
describe("mention search transport", () => {
  it("cancels slow discovery promptly and closes a lease returned later", async () => {
    const f = fixture(),
      normal = f.post.getMockImplementation()!;
    let finish!: () => void;
    f.post.mockImplementation((action, body, signal) =>
      action === "mentions/open"
        ? new Promise((done) => {
            finish = () => void normal(action, body, signal).then(done);
          })
        : normal(action, body, signal),
    );
    const pending = f.search();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    f.abort.abort();
    await rejected;
    finish();
    await vi.waitFor(() =>
      expect(f.post.mock.calls.at(-1)?.[0]).toBe("mentions/close"),
    );
    expect(
      f.post.mock.calls.some(([action]) => action === "mentions/search"),
    ).toBe(false);
  });
  it("opens, searches and closes its headless scope with no resource reader", async () => {
    const f = fixture();
    expect(await f.search()).toMatchObject([
      { serverId: "server", item: { resourceUri: "fixture://bolt" } },
    ]);
    expect(f.post.mock.calls.map(([action]) => action)).toEqual([
      "mentions/open",
      "mentions/search",
      "mentions/close",
    ]);
    expect(f.post.mock.calls[1][1]).toMatchObject({
      params: { query: "bolt" },
      instanceToken: token,
    });
    expect(f.post.mock.calls[2][2]).toBeUndefined();
  });
  it("withholds searches for an undeclared provider", async () => {
    const f = fixture();
    f.post.mockResolvedValueOnce(new Response('{"mention":null}'));
    expect(await f.search()).toEqual([]);
    expect(f.post).toHaveBeenCalledTimes(1);
  });
  it("preserves the invocation id across an exact signed approval challenge", async () => {
    const f = fixture();
    let once = true;
    const normal = f.post.getMockImplementation()!;
    f.post.mockImplementation(async (action, body, signal) => {
      if (action === "mentions/search" && once) {
        once = false;
        const request = body as { invocationId: string; params: unknown };
        return new Response(
          JSON.stringify({
            status: "approval_required",
            approval: {
              id: "signed",
              invocationId: request.invocationId,
              name: "mentions",
              params: { name: "mentions", arguments: request.params },
            },
          }),
          { status: 409 },
        );
      }
      return normal(action, body, signal);
    });
    await f.search();
    expect(f.approve).toHaveBeenCalledTimes(1);
    expect(f.post.mock.calls[2][1]).toEqual({
      ...(f.post.mock.calls[1][1] as object),
      approval: { id: "signed", approved: true },
    });
  });
  it("rejects a mismatched approval without resubmitting", async () => {
    const f = fixture(),
      normal = f.post.getMockImplementation()!;
    f.post.mockImplementation(async (action, body, signal) =>
      action === "mentions/search"
        ? new Response(
            JSON.stringify({
              status: "approval_required",
              approval: { id: "forged", name: "other" },
            }),
            { status: 409 },
          )
        : normal(action, body, signal),
    );
    await expect(f.search()).rejects.toThrow("Invalid mention approval");
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledTimes(3);
  });
  it("cleans up cancelled and malformed deliveries without retry", async () => {
    const f = fixture(),
      normal = f.post.getMockImplementation()!;
    f.post.mockImplementation(async (action, body, signal) => {
      if (action === "mentions/search") {
        f.abort.abort();
        return normal(action, body, signal);
      }
      return normal(action, body, signal);
    });
    await expect(f.search()).rejects.toThrow();
    expect(f.post.mock.calls.at(-1)?.[0]).toBe("mentions/close");
    const g = fixture();
    g.post.mockResolvedValueOnce(
      new Response('{"mention":{"instanceToken":"bad"}}'),
    );
    await expect(g.search()).rejects.toThrow();
    expect(g.post).toHaveBeenCalledTimes(1);
  });
  it("reports cleanup failures while preserving valid results", async () => {
    const f = fixture(),
      normal = f.post.getMockImplementation()!;
    f.post.mockImplementation(async (action, body, signal) =>
      action === "mentions/close"
        ? new Response("{}", { status: 403 })
        : normal(action, body, signal),
    );
    expect(await f.search()).toHaveLength(1);
    expect(f.cleanupError).toHaveBeenCalledTimes(1);
  });
});
