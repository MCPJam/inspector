import { describe, it, expect, vi } from "vitest";
import type { WidgetHost } from "@mcpjam/widget-react";
import type { ThreadAppApi, ThreadAppHandle } from "../thread-app-api";
import { withLocalFileHost } from "../local-file-host";
const base = {
  services: {},
  resolvers: { resolveEffectiveHostCapabilities: () => ({}) },
} as unknown as WidgetHost;
function fixture(
  entries = [
    {
      kind: "file",
      toolName: "view",
      title: "Viewer",
      resourceUri: "cad://part",
    },
  ],
  choose?: (entries: any[], signal: AbortSignal) => Promise<any>,
) {
  let request: any;
  const resolveLocalFile = vi.fn(async () => entries);
  const open = vi.fn(async () => {});
  const lifetime = new AbortController();
  const host = withLocalFileHost(
    base,
    { resolveLocalFile } as unknown as ThreadAppApi,
    { localFilesAvailable: true } as ThreadAppHandle,
    lifetime.signal,
    open,
    choose,
  );
  const cleanup = host.services.configureAppBridge!(
    {
      setRequestHandler: (_schema: unknown, handler: any) => {
        request = handler;
      },
    } as any,
    { experimental: { "openai/files": {} } },
  );
  return {
    request: () =>
      request(
        { params: { path: "/disposable/part.stl" } },
        { signal: new AbortController().signal },
      ),
    resolveLocalFile,
    open,
    lifetime,
    cleanup,
    host,
  };
}
describe("authorized local file opening", () => {
  it("withholds the capability and handler without admitted placement", () => {
    expect(
      withLocalFileHost(
        base,
        {} as ThreadAppApi,
        {} as ThreadAppHandle,
        new AbortController().signal,
        async () => {},
      ),
    ).toBe(base);
  });
  it("opens only the returned target after resolving through the original handle", async () => {
    const f = fixture();
    await expect(f.request()).resolves.toEqual({});
    expect(f.resolveLocalFile).toHaveBeenCalledWith(
      { localFilesAvailable: true },
      "/disposable/part.stl",
      expect.any(AbortSignal),
    );
    expect(f.open).toHaveBeenCalledWith({
      kind: "file",
      toolName: "view",
      title: "Viewer",
      resourceUri: "cad://part",
    });
  });
  const two = [
    { kind: "file", toolName: "one", title: "One", resourceUri: "cad://part" },
    { kind: "file", toolName: "two", title: "Two", resourceUri: "cad://part" },
  ];
  it("refuses missing and unchosen viewers without activation", async () => {
    const missing = fixture([]);
    await expect(missing.request()).rejects.toThrow("No file viewer");
    expect(missing.open).not.toHaveBeenCalled();
    const unchosen = fixture(two);
    await expect(unchosen.request()).rejects.toThrow("No unique");
    expect(unchosen.open).not.toHaveBeenCalled();
    const cancelled = fixture(two, async () => null);
    await expect(cancelled.request()).rejects.toThrow("No file viewer was chosen");
    expect(cancelled.open).not.toHaveBeenCalled();
  });
  it("offers the same Open with choice when several viewers match", async () => {
    const choose = vi.fn(async (entries: any[]) => entries[1]);
    const f = fixture(two, choose);
    await expect(f.request()).resolves.toEqual({});
    expect(choose).toHaveBeenCalledWith(two, expect.any(AbortSignal));
    expect(f.open).toHaveBeenCalledWith(two[1]);
  });
  it("stops after its bridge or owning instance closes", async () => {
    const f = fixture();
    f.cleanup?.();
    await expect(f.request()).rejects.toThrow("closed");
    expect(f.resolveLocalFile).not.toHaveBeenCalled();
    const g = fixture();
    g.lifetime.abort();
    await expect(g.request()).rejects.toBeDefined();
    expect(g.resolveLocalFile).not.toHaveBeenCalled();
  });
  it("does not activate a result delivered after owner cancellation", async () => {
    const f = fixture();
    f.resolveLocalFile.mockImplementation(async () => {
      f.lifetime.abort();
      return [
        {
          kind: "file",
          toolName: "view",
          title: "Viewer",
          resourceUri: "cad://part",
        },
      ];
    });
    await expect(f.request()).rejects.toBeDefined();
    expect(f.open).not.toHaveBeenCalled();
  });
});
