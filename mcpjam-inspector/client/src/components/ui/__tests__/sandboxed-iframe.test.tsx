/**
 * Pins the `sandboxAttrs` semantic switch on the outer iframe `sandbox=`:
 *
 *   - `sandboxAttrs: undefined` (no profile opinion) → preserve the
 *     caller-supplied permissive baseline so legacy callers behave
 *     unchanged.
 *   - `sandboxAttrs: []` (profile explicitly modeling a strict host) →
 *     emit only the spec-mandated `allow-scripts allow-same-origin`.
 *   - `sandboxAttrs: ["allow-forms"]` → spec-mandated minimum PLUS that
 *     token, NOT unioned with the legacy baseline.
 *
 * Locks the contract so a future refactor of `sandboxed-iframe.tsx` or
 * `mcp-apps-renderer.tsx` can't silently re-grant tokens like
 * `allow-popups-to-escape-sandbox` on profiles that explicitly model a
 * stricter real host.
 */
import { describe, it, expect, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { SandboxedIframe } from "@/components/ui/sandboxed-iframe";

function getOuterIframeSandbox(container: HTMLElement): string[] {
  const iframe = container.querySelector("iframe");
  expect(iframe).not.toBeNull();
  return (iframe!.getAttribute("sandbox") ?? "")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .sort();
}

describe("SandboxedIframe — outer sandbox attribute", () => {
  it("preserves the caller's permissive baseline when sandboxAttrs is undefined", () => {
    // No profile opinion → legacy callers (which pass a wide permissive
    // baseline) keep their pre-feature behavior. Spec-mandated tokens are
    // still always present as a defense-in-depth guarantee.
    const { container } = render(
      <SandboxedIframe
        html={null}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        onMessage={() => {}}
      />
    );
    const tokens = getOuterIframeSandbox(container);
    expect(tokens).toEqual([
      "allow-forms",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-same-origin",
      "allow-scripts",
    ]);
  });

  it("collapses to the spec-mandated minimum when sandboxAttrs: []", () => {
    // Explicit `[]` = "profile models a host that emits the spec minimum
    // only." The caller's wide `sandbox` prop is ignored in favor of the
    // profile, so tokens like `allow-popups-to-escape-sandbox` must NOT
    // appear.
    const { container } = render(
      <SandboxedIframe
        html={null}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        sandboxAttrs={[]}
        onMessage={() => {}}
      />
    );
    const tokens = getOuterIframeSandbox(container);
    expect(tokens).toEqual(["allow-same-origin", "allow-scripts"]);
  });

  it("emits spec-mandated minimum + profile tokens when sandboxAttrs is non-empty", () => {
    // A Claude-modeled profile carries `allow-forms`; the renderer's
    // legacy permissive baseline must NOT subsume it into a wider grant.
    const { container } = render(
      <SandboxedIframe
        html={null}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        sandboxAttrs={["allow-forms"]}
        onMessage={() => {}}
      />
    );
    const tokens = getOuterIframeSandbox(container);
    expect(tokens).toEqual([
      "allow-forms",
      "allow-same-origin",
      "allow-scripts",
    ]);
  });

  it("dedupes when sandboxAttrs repeats the spec-mandated tokens", () => {
    // Mandatory tokens are unioned regardless of input order or duplicates.
    const { container } = render(
      <SandboxedIframe
        html={null}
        sandboxAttrs={["allow-scripts", "allow-forms", "allow-scripts"]}
        onMessage={() => {}}
      />
    );
    const tokens = getOuterIframeSandbox(container);
    expect(tokens).toEqual([
      "allow-forms",
      "allow-same-origin",
      "allow-scripts",
    ]);
  });

  it("remounts the outer iframe when sandboxAttrs changes (so new sandbox flags take effect)", () => {
    // Browsers apply iframe `sandbox=` only on navigation; mutating
    // the attribute on a mounted iframe does not retroactively change
    // its grants. If we didn't remount, editing a profile from
    // permissive tokens to `[]` would leave the running widget with
    // popups/forms/etc. enabled even though the matrix shows the
    // stricter model. Asserts the iframe DOM identity changes when
    // outerSandboxAttribute does.
    const { container, rerender } = render(
      <SandboxedIframe
        html={null}
        sandboxAttrs={["allow-forms", "allow-popups"]}
        onMessage={() => {}}
      />
    );
    const firstIframe = container.querySelector("iframe");
    expect(firstIframe).not.toBeNull();
    rerender(
      <SandboxedIframe html={null} sandboxAttrs={[]} onMessage={() => {}} />
    );
    const secondIframe = container.querySelector("iframe");
    expect(secondIframe).not.toBeNull();
    expect(secondIframe).not.toBe(firstIframe);
    // The remounted iframe carries the strict spec-minimum sandbox.
    expect(getOuterIframeSandbox(container)).toEqual([
      "allow-same-origin",
      "allow-scripts",
    ]);
  });

  it("rejects sandboxAttrs entries with internal whitespace (silent-widen guard)", () => {
    // Regression: `"allow-forms allow-popups-to-escape-sandbox"` as a
    // single Set entry would otherwise emit two real sandbox flags via
    // join(" "), silently widening the iframe grants beyond what the
    // editor/matrix display.
    const { container } = render(
      <SandboxedIframe
        html={null}
        sandboxAttrs={["allow-forms allow-popups-to-escape-sandbox"]}
        onMessage={() => {}}
      />
    );
    const tokens = getOuterIframeSandbox(container);
    // The whitespace-bearing entry is dropped entirely. Mandatory
    // tokens remain; the smuggled flags do NOT.
    expect(tokens).toEqual(["allow-same-origin", "allow-scripts"]);
    expect(tokens).not.toContain("allow-forms");
    expect(tokens).not.toContain("allow-popups-to-escape-sandbox");
  });
});

describe("SandboxedIframe — outer allow attribute (allowFeatures injection guard)", () => {
  function getOuterIframeAllow(container: HTMLElement): string {
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    return iframe!.getAttribute("allow") ?? "";
  }

  it("drops allowFeatures entries with ';' in the value — directive-injection guard", () => {
    // A crafted profile that put `fullscreen: "*; camera *"` would
    // otherwise smuggle `camera *` past the spec-feature key filter
    // (since `;` is the Permissions Policy separator). Defense in depth
    // for the canonicalizer's reject-at-write-time check.
    const { container } = render(
      <SandboxedIframe
        html={null}
        allowFeatures={{ fullscreen: "*; camera *" }}
        onMessage={() => {}}
      />
    );
    const allow = getOuterIframeAllow(container);
    expect(allow).not.toContain("camera");
    expect(allow).not.toContain("fullscreen");
  });

  it("drops allowFeatures entries with ',' in the value", () => {
    const { container } = render(
      <SandboxedIframe
        html={null}
        allowFeatures={{ fullscreen: "*, camera *" }}
        onMessage={() => {}}
      />
    );
    const allow = getOuterIframeAllow(container);
    expect(allow).not.toContain("camera");
    expect(allow).not.toContain("fullscreen");
  });

  it("keeps clean allowFeatures entries through", () => {
    const { container } = render(
      <SandboxedIframe
        html={null}
        allowFeatures={{ fullscreen: "*" }}
        onMessage={() => {}}
      />
    );
    expect(getOuterIframeAllow(container)).toContain("fullscreen *");
  });

  it("drops allowFeatures keys with whitespace (spec-feature-bypass guard)", () => {
    // Regression: a key like `"camera *"` doesn't match the spec-feature
    // filter (exact-equals `"camera"`), so without a whitespace check it
    // would flow through as `camera * *`, which the browser parses as a
    // camera grant — bypassing `permissions.allow` as the single source
    // of truth for the 4 spec permissions.
    const { container } = render(
      <SandboxedIframe
        html={null}
        allowFeatures={{ "camera *": "*" }}
        onMessage={() => {}}
      />
    );
    const allow = getOuterIframeAllow(container);
    expect(allow).not.toContain("camera");
  });

  // Mirror of the sandboxAttrs authoritative-profile contract: when a
  // profile uses allowFeatures to model a real host's `allow=` shape, the
  // renderer's legacy `local-network-access *` / `midi *` defaults are
  // dropped so MCPJam matches the real host's grant set. Spec-permission
  // entries from `permissions` are orthogonal and still flow through.

  it("preserves legacy local-network-access + midi defaults when allowFeatures is undefined", () => {
    const { container } = render(
      <SandboxedIframe html={null} onMessage={() => {}} />
    );
    const allow = getOuterIframeAllow(container);
    expect(allow).toContain("local-network-access *");
    expect(allow).toContain("midi *");
  });

  it("drops legacy local-network-access + midi defaults when allowFeatures is provided (even {})", () => {
    // The profile is authoritative: a host that doesn't list
    // local-network-access / midi shouldn't have them silently granted by
    // the inspector.
    const { container } = render(
      <SandboxedIframe html={null} allowFeatures={{}} onMessage={() => {}} />
    );
    const allow = getOuterIframeAllow(container);
    expect(allow).not.toContain("local-network-access");
    expect(allow).not.toContain("midi");
  });

  it("still emits spec-permission grants from `permissions` even when allowFeatures is authoritative", () => {
    // SEP-1865 spec permissions and allowFeatures are orthogonal —
    // `allowFeatures: {}` shouldn't suppress a `permissions.camera` grant.
    const { container } = render(
      <SandboxedIframe
        html={null}
        permissions={{ camera: {} }}
        allowFeatures={{}}
        onMessage={() => {}}
      />
    );
    const allow = getOuterIframeAllow(container);
    expect(allow).toContain("camera *");
    expect(allow).not.toContain("local-network-access");
  });
});

describe("SandboxedIframe — resource-ready delivery", () => {
  function dispatchFromIframe(iframe: HTMLIFrameElement, data: unknown): void {
    const proxyOrigin = new URL(iframe.src).origin;
    const event = new MessageEvent("message", {
      data,
      source: iframe.contentWindow!,
      origin: proxyOrigin,
    });
    window.dispatchEvent(event);
  }

  it("does not resend sandbox-resource-ready for semantically unchanged payloads", async () => {
    const renderIframe = (csp: { connectDomains: string[] }) => (
      <SandboxedIframe
        html="<html><body>widget</body></html>"
        csp={{
          connectDomains: csp.connectDomains,
          resourceDomains: [],
          frameDomains: [],
          baseUriDomains: [],
        }}
        permissions={{ clipboardWrite: {} }}
        sandboxAttrs={["allow-forms"]}
        cspDirectives={{ "script-src": ["'unsafe-inline'"] }}
        onMessage={() => {}}
      />
    );
    const { container, rerender } = render(
      renderIframe({ connectDomains: ["https://api.example.com"] })
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(iframe.contentWindow!, "postMessage");

    act(() => {
      dispatchFromIframe(iframe, {
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-proxy-ready",
      });
    });

    await vi.waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledTimes(1);
    });

    rerender(renderIframe({ connectDomains: ["https://api.example.com"] }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(postMessageSpy).toHaveBeenCalledTimes(1);

    rerender(renderIframe({ connectDomains: ["https://next.example.com"] }));

    await vi.waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledTimes(2);
    });
  });
});

describe("SandboxedIframe — non-JSON-RPC message allow-list", () => {
  // The handler at sandboxed-iframe.tsx:165-205 only forwards messages that
  // either (a) match a small non-JSON-RPC allow-list or (b) carry
  // `jsonrpc: "2.0"`. Anything else is dropped. This is the integration
  // point where the widget-renderer-consolidation regressed: the compat
  // runtime's `openai:setWidgetState` postMessage is non-JSON-RPC and was
  // silently dropped before being added to the allow-list, breaking widget
  // state persistence on the unified path. These tests pin the allow-list.
  //
  // They render the real component and dispatch synthetic MessageEvents
  // whose `source` matches the rendered iframe's contentWindow and whose
  // `origin` matches the sandbox-proxy origin the component derived from
  // `window.location`.

  function dispatchFromIframe(iframe: HTMLIFrameElement, data: unknown): void {
    // The component swaps localhost↔127.0.0.1 to satisfy SEP-1865's
    // different-origin requirement; derive the same origin here.
    const proxyOrigin = new URL(iframe.src).origin;
    const event = new MessageEvent("message", {
      data,
      source: iframe.contentWindow!,
      origin: proxyOrigin,
    });
    window.dispatchEvent(event);
  }

  it("forwards openai:setWidgetState (regression: widget-renderer consolidation)", () => {
    // Without this entry in the allow-list, Apps SDK widgets calling
    // window.openai.setWidgetState(...) silently lose state — the message
    // reaches the sandbox proxy and gets forwarded toward the host, but the
    // outer iframe handler bails on the `jsonrpc !== "2.0"` gate. Pin the
    // forwarding so a future tightening of the allow-list can't regress
    // saved-view / replay / fork persistence.
    const onMessage = vi.fn();
    const { container } = render(
      <SandboxedIframe html={null} onMessage={onMessage} />
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    dispatchFromIframe(iframe, {
      type: "openai:setWidgetState",
      toolId: "tool-1",
      state: { counter: 5 },
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].data).toEqual({
      type: "openai:setWidgetState",
      toolId: "tool-1",
      state: { counter: 5 },
    });
  });

  it("forwards openai:setOpenInAppUrl", () => {
    const onMessage = vi.fn();
    const { container } = render(
      <SandboxedIframe html={null} onMessage={onMessage} />
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    dispatchFromIframe(iframe, {
      type: "openai:setOpenInAppUrl",
      toolId: "tool-1",
      href: "https://app.example.com/item/42",
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].data).toEqual({
      type: "openai:setOpenInAppUrl",
      toolId: "tool-1",
      href: "https://app.example.com/item/42",
    });
  });

  it("forwards openai:uploadFile", () => {
    const onMessage = vi.fn();
    const { container } = render(
      <SandboxedIframe html={null} onMessage={onMessage} />
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    dispatchFromIframe(iframe, {
      type: "openai:uploadFile",
      callId: 1,
      data: "deadbeef",
      mimeType: "image/png",
      fileName: "t.png",
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("forwards openai:getFileDownloadUrl", () => {
    const onMessage = vi.fn();
    const { container } = render(
      <SandboxedIframe html={null} onMessage={onMessage} />
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    dispatchFromIframe(iframe, {
      type: "openai:getFileDownloadUrl",
      callId: 2,
      fileId: "file_abc",
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("forwards mcp-apps:csp-violation", () => {
    const onMessage = vi.fn();
    const { container } = render(
      <SandboxedIframe html={null} onMessage={onMessage} />
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    dispatchFromIframe(iframe, {
      type: "mcp-apps:csp-violation",
      directive: "script-src",
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("forwards recorder readiness messages", () => {
    const onMessage = vi.fn();
    const { container } = render(
      <SandboxedIframe html={null} onMessage={onMessage} />
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    dispatchFromIframe(iframe, { type: "recorder:ready" });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the window message listener stable when callbacks are recreated", () => {
    const addListenerSpy = vi.spyOn(window, "addEventListener");
    const removeListenerSpy = vi.spyOn(window, "removeEventListener");
    const firstOnMessage = vi.fn();
    const secondOnMessage = vi.fn();

    const { container, rerender } = render(
      <SandboxedIframe
        html={null}
        onMessage={firstOnMessage}
        onProxyReady={() => {}}
      />
    );
    const initialMessageListenerAdds = addListenerSpy.mock.calls.filter(
      ([type]) => type === "message"
    ).length;

    rerender(
      <SandboxedIframe
        html={null}
        onMessage={secondOnMessage}
        onProxyReady={() => {}}
      />
    );

    expect(
      addListenerSpy.mock.calls.filter(([type]) => type === "message").length
    ).toBe(initialMessageListenerAdds);
    expect(
      removeListenerSpy.mock.calls.filter(([type]) => type === "message").length
    ).toBe(0);

    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    dispatchFromIframe(iframe, { type: "recorder:ready" });
    expect(firstOnMessage).not.toHaveBeenCalled();
    expect(secondOnMessage).toHaveBeenCalledTimes(1);

    addListenerSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it("drops non-JSON-RPC messages that are not in the allow-list", () => {
    // Belt-and-suspenders: a future "let's add openai:foo" change must
    // pass through the allow-list, not bypass it. If this assertion ever
    // needs to flip, the runtime's contract changed and the test should
    // be updated deliberately.
    const onMessage = vi.fn();
    const { container } = render(
      <SandboxedIframe html={null} onMessage={onMessage} />
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    dispatchFromIframe(iframe, { type: "recorder:proxy-status", x: 1 });
    dispatchFromIframe(iframe, { type: "openai:unknownSomething", x: 1 });
    dispatchFromIframe(iframe, { hello: "world" });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("forwards generic JSON-RPC 2.0 messages", () => {
    const onMessage = vi.fn();
    const { container } = render(
      <SandboxedIframe html={null} onMessage={onMessage} />
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    dispatchFromIframe(iframe, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "search", arguments: {} },
      id: 1,
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("swallows ui/notifications/sandbox-* messages (internal proxy lifecycle)", () => {
    // The spec reserves `ui/notifications/sandbox-*` for the proxy↔host
    // bootstrap and the component handles them internally. They must not
    // bubble out to consumers — otherwise mcp-apps-renderer would see
    // sandbox-proxy-ready / sandbox-resource-ready as widget messages.
    const onMessage = vi.fn();
    const { container } = render(
      <SandboxedIframe html={null} onMessage={onMessage} />
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    dispatchFromIframe(iframe, {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: {},
    });
    expect(onMessage).not.toHaveBeenCalled();
  });
});
