import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxedIframe } from "../sandboxed-iframe";

afterEach(cleanup);

function proxyReady(iframe: HTMLIFrameElement) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" },
      source: iframe.contentWindow!,
      origin: new URL(iframe.src).origin,
    })
  );
}

describe("SandboxedIframe guest reloads", () => {
  it("reloads the guest for a new reload key and never for an unchanged one", async () => {
    const view = (reloadKey: number) => (
      <SandboxedIframe
        html="<html><body>app</body></html>"
        reloadKey={reloadKey}
        onMessage={() => {}}
      />
    );
    const { container, rerender } = render(view(1));
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    act(() => proxyReady(iframe));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toMatchObject({
      method: "ui/notifications/sandbox-resource-ready",
    });

    rerender(view(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(post).toHaveBeenCalledTimes(1);

    // Same HTML and policy, but a new bridge: the guest must load again so
    // it initializes the bridge that is listening now.
    rerender(view(2));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][0]).toMatchObject({
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: "<html><body>app</body></html>" },
    });
  });
});
