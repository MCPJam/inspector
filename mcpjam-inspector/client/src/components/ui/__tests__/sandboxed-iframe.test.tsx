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
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
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
      />,
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
      />,
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
      />,
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
      />,
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
      />,
    );
    const firstIframe = container.querySelector("iframe");
    expect(firstIframe).not.toBeNull();
    rerender(
      <SandboxedIframe
        html={null}
        sandboxAttrs={[]}
        onMessage={() => {}}
      />,
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
      />,
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
      />,
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
      />,
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
      />,
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
      />,
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
      <SandboxedIframe html={null} onMessage={() => {}} />,
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
      <SandboxedIframe
        html={null}
        allowFeatures={{}}
        onMessage={() => {}}
      />,
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
      />,
    );
    const allow = getOuterIframeAllow(container);
    expect(allow).toContain("camera *");
    expect(allow).not.toContain("local-network-access");
  });
});
