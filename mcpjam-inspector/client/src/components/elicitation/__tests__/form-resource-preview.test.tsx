import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: ports.fetch }));
import {
  formResourcePreviewPorts,
  PLUGIN_FORM_PREVIEW_TIMEOUT_MS,
} from "../form-resource-preview";
import { PluginDescribedError } from "@/shared/plugin-operation";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
const target = {
  type: "resource_link" as const,
  uri: "fixture://preview",
  name: "Synthetic",
};
const parent = { kind: "legacy" as const, id: "parent", round: 0 as const };
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(contents: unknown[]) {
  const create = vi.fn(() => `blob:owned-${crypto.randomUUID()}`);
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  ports.fetch
    .mockReset()
    .mockImplementation(
      async () => new Response(JSON.stringify({ type: "resource", contents })),
    );
  const abort = new AbortController();
  const service = formResourcePreviewPorts(
    { projectId: "project", workspaceId: "workspace" },
    "source",
    parent,
    Date.now() + 10000,
  );
  return { create, revoke, abort, service };
}
describe("actual resource preview port and owned browser bytes", () => {
  it("releases an open URL at the immutable form deadline", async () => {
    const f = fixture([
      { uri: target.uri, mimeType: "image/png", blob: "AA==" },
    ]);
    const service = formResourcePreviewPorts(
      { projectId: "project", workspaceId: "workspace" },
      "source",
      parent,
      Date.now() + 30,
    );
    const opened = await service.preview!(target, f.abort.signal);
    render(<>{opened.content}</>);
    await vi.waitFor(() => expect(f.revoke).toHaveBeenCalledOnce());
    expect(screen.getByRole("img").getAttribute("src")).toBeNull();
    opened.release();
    expect(f.revoke).toHaveBeenCalledOnce();
  });
  it("reports decoder refusal without loading a fallback URL", async () => {
    const f = fixture([
      { uri: target.uri, mimeType: "image/png", blob: "AA==" },
    ]);
    const opened = await f.service.preview!(target, f.abort.signal);
    render(<>{opened.content}</>);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("could not be decoded");
    expect(f.create).toHaveBeenCalledOnce();
    opened.release();
    expect(f.revoke).toHaveBeenCalledOnce();
  });
  it("renders exact bytes without loading the resource URI and releases once on close", async () => {
    const f = fixture(
      [
        { ...target, type: undefined, mimeType: "image/png", blob: "AP8AgCo=" },
      ].map(({ uri, mimeType, blob }) => ({ uri, mimeType, blob })),
    );
    const opened = await f.service.preview!(target, f.abort.signal);
    const view = render(<>{opened.content}</>);
    expect(screen.getByRole("img").getAttribute("src")).toMatch(/^blob:owned-/);
    expect(screen.getByRole("img").getAttribute("alt")).toBe(
      "Synthetic preview",
    );
    expect(f.create.mock.calls[0][0].type).toBe("image/png");
    expect(f.create.mock.calls[0][0].size).toBe(5);
    opened.release();
    opened.release();
    expect(f.revoke).toHaveBeenCalledOnce();
    expect(screen.getByRole("img").getAttribute("src")).toBeNull();
    view.unmount();
  });
  it.each(["audio/wav", "video/webm"])(
    "stops %s and revokes on request abort",
    async (mimeType) => {
      const f = fixture([{ uri: target.uri, mimeType, blob: "AA==" }]);
      const opened = await f.service.preview!(target, f.abort.signal);
      render(<>{opened.content}</>);
      const media = document.querySelector("audio,video")!;
      expect(media.hasAttribute("autoplay")).toBe(false);
      act(() => f.abort.abort());
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
      expect(media.getAttribute("src")).toBeNull();
      expect(f.revoke).toHaveBeenCalledOnce();
      opened.release();
      expect(f.revoke).toHaveBeenCalledOnce();
    },
  );
  it("releases a partial allocation if another object URL fails", async () => {
    const f = fixture(
      ["image/png", "audio/wav"].map((mimeType) => ({
        uri: target.uri,
        mimeType,
        blob: "AA==",
      })),
    );
    f.create
      .mockImplementationOnce(() => "blob:one")
      .mockImplementationOnce(() => {
        throw new Error("Allocation refused");
      });
    await expect(f.service.preview!(target, f.abort.signal)).rejects.toThrow();
    expect(f.revoke).toHaveBeenCalledExactlyOnceWith("blob:one");
  });
  it("refuses a foreign URI or unsupported format before allocating bytes", async () => {
    const f = fixture([
      { uri: "fixture://foreign", mimeType: "image/png", blob: "AA==" },
    ]);
    await expect(f.service.preview!(target, f.abort.signal)).rejects.toThrow();
    ports.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "resource",
          contents: [
            { uri: target.uri, mimeType: "image/svg+xml", blob: "AA==" },
          ],
        }),
      ),
    );
    await expect(f.service.preview!(target, f.abort.signal)).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
  });
  it("fences aborted JSON delivery before allocating a URL", async () => {
    const f = fixture([]);
    ports.fetch.mockResolvedValue({
      ok: true,
      json: async () => {
        f.abort.abort();
        return {
          type: "resource",
          contents: [{ uri: target.uri, mimeType: "image/png", blob: "AA==" }],
        };
      },
    });
    await expect(f.service.preview!(target, f.abort.signal)).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
  });
});

describe("a preview that can't open", () => {
  const server = { serverId: "fixture-server", serverName: "Fixture" };
  const open = () =>
    formResourcePreviewPorts(
      { projectId: "project", workspaceId: "workspace" },
      "source",
      parent,
      Date.now() + 10 * 60_000,
      server,
    );
  const logs = () =>
    useTrafficLogStore
      .getState()
      .mcpServerItems.filter((item) => item.serverId === "fixture-server");

  it("fails within the deadline even when the request can't be cancelled, with one Logs entry", async () => {
    useTrafficLogStore.getState().clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let answer!: (value: Response) => void;
    // A stalled bearer lookup or server: the request ignores its signal.
    ports.fetch.mockReset().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const create = vi.fn(() => "blob:late");
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
    const opening = open().preview!(target, new AbortController().signal);
    const settled = opening.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(PLUGIN_FORM_PREVIEW_TIMEOUT_MS - 1);
    expect(logs()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const error = await settled;
    expect(error).toBeInstanceOf(PluginDescribedError);
    expect(error).toMatchObject({ code: "PLUGIN_FORM_PREVIEW_TIMEOUT" });
    expect((error as Error).message).toMatch(
      /didn't open within 30 seconds.*answers are unchanged/,
    );
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toMatchObject({
      method: "plugin-extensions/PLUGIN_FORM_PREVIEW_TIMEOUT",
      serverName: "Fixture",
      payload: expect.objectContaining({
        title: "Preview didn't open: Synthetic",
        uri: target.uri,
      }),
    });
    // A late answer allocates nothing.
    answer(
      Response.json({
        type: "resource",
        contents: [{ uri: target.uri, mimeType: "image/png", blob: "AA==" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("shows the server's own description for a refusal, with one Logs entry", async () => {
    useTrafficLogStore.getState().clear();
    ports.fetch.mockReset().mockResolvedValue(
      Response.json(
        {
          code: "FORM_PREVIEW_UNAVAILABLE",
          description: "That preview isn't available for this form.",
        },
        { status: 403 },
      ),
    );
    await expect(
      open().preview!(target, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "FORM_PREVIEW_UNAVAILABLE",
      message: "That preview isn't available for this form.",
    });
    expect(logs()).toHaveLength(1);
    expect(logs()[0].method).toBe(
      "plugin-extensions/FORM_PREVIEW_UNAVAILABLE",
    );
  });

  it("logs nothing when the field closes before the preview opens", async () => {
    useTrafficLogStore.getState().clear();
    ports.fetch.mockReset().mockImplementation(() => new Promise(() => {}));
    const abort = new AbortController();
    const opening = open().preview!(target, abort.signal);
    abort.abort();
    await expect(opening).rejects.toThrow();
    expect(logs()).toHaveLength(0);
  });

  it("bounds only opening: an open preview outlives the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture([
      { uri: target.uri, mimeType: "image/png", blob: "AA==" },
    ]);
    const opened = await open().preview!(target, f.abort.signal);
    render(<>{opened.content}</>);
    await vi.advanceTimersByTimeAsync(2 * PLUGIN_FORM_PREVIEW_TIMEOUT_MS);
    expect(f.revoke).not.toHaveBeenCalled();
    expect(screen.getByRole("img").getAttribute("src")).toMatch(/^blob:/);
    opened.release();
    expect(f.revoke).toHaveBeenCalledOnce();
  });
});
