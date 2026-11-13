import { createRef, StrictMode } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedSandboxView, PrepareSandboxViewRequest } from "@mcpjam/sdk/widget-runtime";
import { SandboxedIframe, type SandboxedIframeHandle } from "../sandboxed-iframe";
import { useSandboxView, type SandboxViewAdmission } from "../use-sandbox-view";
import { SandboxViewAdmissionError } from "../sandbox-view-error";

const first: PreparedSandboxView = {
  admissionId: "first", proxyUrl: "http://127.0.0.1:64001/admitted",
  htmlSha256: "a".repeat(64), expiresAt: Date.now() + 2 * 60 * 60_000,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const prepare = vi.fn<(request: PrepareSandboxViewRequest, signal?: AbortSignal) => Promise<PreparedSandboxView>>();
  const release = vi.fn().mockResolvedValue(undefined);
  const admission: SandboxViewAdmission = {
    services: { prepareSandboxView: prepare, releaseSandboxView: release },
    request: {
      html: "<p>app</p>", sourceReceipt: "receipt",
      source: { serverId: "server", resourceUri: "ui://app", toolCallId: "tool" },
      policy: { permissive: false }, mode: "declared",
    },
  };
  return { prepare, release, admission };
}

afterEach(async () => { cleanup(); await Promise.resolve(); vi.useRealTimers(); });

describe("admitted sandbox lifecycle", () => {
  it("keeps the frame blank until admitted, independently of bridge HTML readiness", async () => {
    const { prepare, admission } = setup();
    const pending = deferred<PreparedSandboxView>();
    prepare.mockReturnValue(pending.promise);
    const ref = createRef<SandboxedIframeHandle>();
    const view = (html: string | null) => <SandboxedIframe ref={ref} html={html} viewAdmission={admission} onMessage={() => {}} />;
    const { container, rerender } = render(view(null));
    const iframe = container.querySelector("iframe")!;
    expect(iframe.getAttribute("src")).toBe("about:blank");
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    expect(() => ref.current?.postMessage({ jsonrpc: "2.0", method: "test" })).not.toThrow();
    expect(post).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(first));
    expect(iframe.src).toBe(first.proxyUrl);
    rerender(view("<p>app</p>"));
    expect(container.querySelector("iframe")).toBe(iframe);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("posts nothing while new HTML is admitted again after the proxy was ready", async () => {
    const { prepare, admission } = setup();
    const next = deferred<PreparedSandboxView>();
    prepare.mockResolvedValueOnce(first).mockReturnValueOnce(next.promise);
    const view = (html: string) => (
      <SandboxedIframe
        html={html}
        colorScheme="dark"
        viewAdmission={{ ...admission, request: { ...admission.request, html } }}
        onMessage={() => {}}
      />
    );
    const { container, rerender } = render(view("<p>app</p>"));
    await act(async () => { await Promise.resolve(); });
    const iframe = container.querySelector("iframe")!;
    expect(iframe.src).toBe(first.proxyUrl);
    const post = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" },
        source: iframe.contentWindow!, origin: new URL(first.proxyUrl).origin,
      }));
    });
    expect(post).toHaveBeenCalled();
    post.mockClear();

    rerender(view("<p>new</p>"));
    await act(async () => { await Promise.resolve(); });
    expect(post).not.toHaveBeenCalled();
  });

  it("does not load the legacy proxy after an admission failure", async () => {
    const { prepare, admission } = setup();
    prepare.mockRejectedValue(new Error("unavailable"));
    const { container } = render(<SandboxedIframe html="<p>app</p>" viewAdmission={admission} onMessage={() => {}} />);
    await screen.findByRole("alert");
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("survives StrictMode effect rehearsal and releases on actual unmount", async () => {
    const { prepare, release, admission } = setup();
    prepare.mockResolvedValue(first);
    const { result, unmount } = renderHook(() => useSandboxView(admission), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.result).toEqual(first);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    unmount();
    await act(async () => { await Promise.resolve(); });
    expect(release).toHaveBeenCalledExactlyOnceWith({ admissionId: first.admissionId });
  });

  it("releases a late result after the owning content changed", async () => {
    const { prepare, release, admission } = setup();
    const old = deferred<PreparedSandboxView>();
    const next = deferred<PreparedSandboxView>();
    prepare.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook((value) => useSandboxView(value), { initialProps: admission });
    rerender({ ...admission, request: { ...admission.request, html: "<p>new</p>" } });
    await act(async () => old.resolve(first));
    expect(result.current.result).toBeUndefined();
    expect(release).toHaveBeenCalledWith({ admissionId: first.admissionId });
    const second = { ...first, admissionId: "second", proxyUrl: "http://127.0.0.1:64002/admitted" };
    await act(async () => next.resolve(second));
    expect(result.current.result).toEqual(second);
    expect(prepare.mock.calls[0][0].viewInstanceId).not.toBe(prepare.mock.calls[1][0].viewInstanceId);
  });

  it("renews a retained view without changing its origin or identity", async () => {
    vi.useFakeTimers();
    const { prepare, release, admission } = setup();
    prepare.mockImplementation(async () => ({ ...first, expiresAt: Date.now() + 2 * 60 * 60_000 }));
    const { result } = renderHook(() => useSandboxView(admission));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(31 * 60_000); });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1][0]).toMatchObject({
      admissionId: first.admissionId, viewInstanceId: prepare.mock.calls[0][0].viewInstanceId,
    });
    expect(result.current.result?.proxyUrl).toBe(first.proxyUrl);
    expect(release).not.toHaveBeenCalled();
  });

  it("retains an unexpired view during a transient renewal failure", async () => {
    vi.useFakeTimers();
    const { prepare, admission } = setup();
    prepare.mockResolvedValue({ ...first, expiresAt: Date.now() + 2 * 60 * 60_000 });
    const { result } = renderHook(() => useSandboxView(admission));
    await act(async () => { await Promise.resolve(); });
    prepare.mockRejectedValueOnce(new Error("temporary network failure"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000); });
    expect(result.current.result?.proxyUrl).toBe(first.proxyUrl);
    expect(result.current.error).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(result.current.result?.proxyUrl).toBe(first.proxyUrl);
  });

  it("stops at lease expiry even when a renewal never responds", async () => {
    vi.useFakeTimers();
    const { prepare, release, admission } = setup();
    prepare.mockResolvedValueOnce({ ...first, expiresAt: Date.now() + 90_000 });
    prepare.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useSandboxView(admission));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(result.current.result).toBeUndefined();
    expect(result.current.error).toBe(new SandboxViewAdmissionError().message);
    expect(release).toHaveBeenCalledWith({ admissionId: first.admissionId });
  });

  it("closes a retained view when renewal is explicitly refused", async () => {
    vi.useFakeTimers();
    const { prepare, release, admission } = setup();
    prepare.mockResolvedValueOnce({ ...first, expiresAt: Date.now() + 2 * 60 * 60_000 });
    prepare.mockRejectedValueOnce(new SandboxViewAdmissionError());
    const { result } = renderHook(() => useSandboxView(admission));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000); });
    expect(result.current.result).toBeUndefined();
    expect(result.current.error).toBe(new SandboxViewAdmissionError().message);
    expect(release).toHaveBeenCalledWith({ admissionId: first.admissionId });
  });
});
