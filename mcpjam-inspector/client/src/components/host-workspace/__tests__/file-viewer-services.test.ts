import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFileViewerServices,
  FILE_VIEWER_REQUEST_DEADLINE_MS,
} from "../file-viewer-services";
import type { ThreadAppApi, ThreadAppHandle } from "../thread-app-api";
import { logExtensionEvent } from "../extension-log";
const state = vi.hoisted(() => ({
  options: undefined as any,
  updated: vi.fn(),
}));
vi.mock("../extension-log", () => ({ logExtensionEvent: vi.fn() }));
vi.mock("@/components/plugin-workspace/file-resource-bridge", () => ({
  createFileResourceBridge: (options: unknown) => {
    state.options = options;
    return { configureAppBridge: vi.fn(), resourceUpdated: state.updated };
  },
}));
const handle = {
  file: { name: "part.cad", resourceUri: "host-resource://file" },
  fileCapabilities: { write: true, subscribe: true },
} as ThreadAppHandle;
describe("retained file viewer ports", () => {
  it("waits for actual watch admission, forwards updates and stops on unsubscribe", async () => {
    let ready!: () => void;
    let notify!: (uri: string) => void;
    let active!: AbortSignal;
    const api = {
      watchFile: vi.fn(
        async (
          _handle: unknown,
          update: (uri: string) => void,
          signal: AbortSignal,
          onReady: () => void,
        ) => {
          notify = update;
          active = signal;
          ready = onReady;
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          );
        },
      ),
      writeFile: vi.fn(async () => ({ outcome: "saved", etag: "v2" })),
    } as unknown as ThreadAppApi;
    const lifetime = new AbortController();
    createFileViewerServices(api, handle, lifetime.signal);
    let admitted = false;
    const pending = state.options
      .send("subscribe-resource", { uri: handle.file!.resourceUri })
      .then(() => {
        admitted = true;
      });
    await Promise.resolve();
    expect(admitted).toBe(false);
    ready();
    await pending;
    expect(admitted).toBe(true);
    state.updated.mockResolvedValue(undefined);
    notify(handle.file!.resourceUri);
    expect(state.updated).toHaveBeenCalledWith(handle.file!.resourceUri);
    await state.options.send("unsubscribe-resource", {});
    expect(active.aborted).toBe(true);
    lifetime.abort();
  });
  it("withholds ports for non-file Apps", () => {
    expect(
      createFileViewerServices(
        {} as ThreadAppApi,
        {} as ThreadAppHandle,
        new AbortController().signal,
      ),
    ).toBeUndefined();
  });
});

describe("bounded file viewer requests", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(logExtensionEvent).mockClear();
  });
  const owner = { serverId: "server-1", serverName: "Parts" };
  const extra = (signal = new AbortController().signal) =>
    ({ signal }) as Parameters<
      NonNullable<ReturnType<typeof createFileViewerServices>>["readResourceV2"]
    >[1];

  it("answers a read that never returns with a described error and a Logs entry", async () => {
    vi.useFakeTimers();
    let readSignal!: AbortSignal;
    const api = {
      readFile: vi.fn(
        (_handle: unknown, _params: unknown, signal: AbortSignal) => {
          readSignal = signal;
          return new Promise(() => {});
        },
      ),
    } as unknown as ThreadAppApi;
    const services = createFileViewerServices(
      api,
      handle,
      new AbortController().signal,
      owner,
    )!;
    const read = services.readResourceV2(
      { uri: handle.file!.resourceUri },
      extra(),
    );
    const outcome = expect(read).rejects.toMatchObject({
      code: "PLUGIN_FILE_READ_TIMEOUT",
      message: expect.stringContaining("didn't load within 12 seconds"),
    });
    await vi.advanceTimersByTimeAsync(FILE_VIEWER_REQUEST_DEADLINE_MS);
    await outcome;
    expect(readSignal.aborted).toBe(true);
    expect(logExtensionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "server-1",
        serverName: "Parts",
        label: "file-viewer",
        level: "error",
        message: expect.stringContaining("part.cad"),
      }),
    );
  });

  it("answers within the deadline and never logs an App's own cancellation", async () => {
    const contents = { contents: [{ uri: "host-resource://file", text: "x" }] };
    const api = {
      readFile: vi
        .fn()
        .mockResolvedValueOnce(contents)
        .mockImplementationOnce(
          (_handle: unknown, _params: unknown, signal: AbortSignal) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason)),
            ),
        ),
    } as unknown as ThreadAppApi;
    const services = createFileViewerServices(
      api,
      handle,
      new AbortController().signal,
      owner,
    )!;
    await expect(
      services.readResourceV2({ uri: handle.file!.resourceUri }, extra()),
    ).resolves.toBe(contents);
    const cancelled = new AbortController();
    const read = services.readResourceV2(
      { uri: handle.file!.resourceUri },
      extra(cancelled.signal),
    );
    cancelled.abort();
    await expect(read).rejects.toBeDefined();
    expect(logExtensionEvent).not.toHaveBeenCalled();
  });

  it("settles a subscription whose watch ends before the server admits it", async () => {
    const api = {
      watchFile: vi.fn(async () => {}),
    } as unknown as ThreadAppApi;
    createFileViewerServices(api, handle, new AbortController().signal, owner);
    await expect(
      state.options.send("subscribe-resource", {
        uri: handle.file!.resourceUri,
      }),
    ).rejects.toBeDefined();
  });

  it("bounds a watch that is never admitted, then starts a fresh one", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const ready: (() => void)[] = [];
    const api = {
      watchFile: vi.fn(
        (
          _handle: unknown,
          _update: unknown,
          signal: AbortSignal,
          onReady: () => void,
        ) => {
          signals.push(signal);
          ready.push(onReady);
          return new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          );
        },
      ),
    } as unknown as ThreadAppApi;
    createFileViewerServices(api, handle, new AbortController().signal, owner);
    const first = state.options.send("subscribe-resource", {
      uri: handle.file!.resourceUri,
    });
    const outcome = expect(first).rejects.toMatchObject({
      code: "PLUGIN_FILE_WATCH_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(FILE_VIEWER_REQUEST_DEADLINE_MS);
    await outcome;
    expect(signals[0].aborted).toBe(true);
    expect(logExtensionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "server-1", level: "error" }),
    );
    const second = state.options.send("subscribe-resource", {
      uri: handle.file!.resourceUri,
    });
    await Promise.resolve();
    expect(api.watchFile).toHaveBeenCalledTimes(2);
    ready[1]();
    await expect(second).resolves.toEqual({});
  });
});
