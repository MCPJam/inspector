/**
 * The preview embed. Three things are load-bearing:
 *
 *  - `?surface=preview` on the src. Without it the guest session the embed
 *    starts is indistinguishable from a real tester's in Sessions.
 *  - The `allow` attribute comes from the host's mcpProfile. Permissions-Policy
 *    ratchets at every iframe boundary, so an attribute that's too narrow
 *    silently blanks UI resources the inner renderer would otherwise allow.
 *  - Cross-origin links are NOT framed. The app's own iframe guard would
 *    render an error page inside the pane; offering the link is the honest
 *    answer.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HostConfigMcpProfileV1 } from "@/lib/client-config-v2";
import { ChatboxPreviewPane } from "../ChatboxPreviewPane";

// jsdom serves the app from localhost — same-origin links must match it.
const sameOriginLink = `${window.location.origin}/chatbox/payments-beta/tok-1`;

describe("ChatboxPreviewPane", () => {
  it("tags the embedded run as preview traffic", () => {
    render(
      <ChatboxPreviewPane publishLink={sameOriginLink} mcpProfile={undefined} />,
    );

    const src = screen
      .getByTestId("user-testing-preview-frame")
      .getAttribute("src");
    expect(new URL(src!).searchParams.get("surface")).toBe("preview");
    // The path shape is what main.tsx's self-embed exception matches on.
    expect(new URL(src!).pathname).toBe("/chatbox/payments-beta/tok-1");
  });

  it("passes the full spec feature set through when the host has no policy", () => {
    render(
      <ChatboxPreviewPane publishLink={sameOriginLink} mcpProfile={undefined} />,
    );

    expect(screen.getByTestId("user-testing-preview-frame")).toHaveAttribute(
      "allow",
      "camera; microphone; geolocation; clipboard-write",
    );
  });

  it("emits an empty allow for a deny-all host", () => {
    const profile = {
      apps: { sandbox: { permissions: { mode: "deny-all" } } },
    } as unknown as HostConfigMcpProfileV1;

    render(
      <ChatboxPreviewPane publishLink={sameOriginLink} mcpProfile={profile} />,
    );

    expect(screen.getByTestId("user-testing-preview-frame")).toHaveAttribute(
      "allow",
      "",
    );
  });

  it("offers the link instead of framing a cross-origin share URL", () => {
    render(
      <ChatboxPreviewPane
        publishLink="https://elsewhere.example/chatbox/x/tok"
        mcpProfile={undefined}
      />,
    );

    expect(
      screen.queryByTestId("user-testing-preview-frame"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /open in a new tab/i }),
    ).toHaveAttribute("href", "https://elsewhere.example/chatbox/x/tok");
  });

  it("shows the empty state, and no frame, without a share link", () => {
    render(<ChatboxPreviewPane publishLink={null} mcpProfile={undefined} />);

    expect(
      screen.queryByTestId("user-testing-preview-frame"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("No share link yet")).toBeInTheDocument();
  });

  it("says the preview runs as the signed-in member, not as a guest", () => {
    render(
      <ChatboxPreviewPane publishLink={sameOriginLink} mcpProfile={undefined} />,
    );

    // Same-origin means the frame shares the dashboard's login, so this is a
    // fidelity caveat the user needs stated, not a detail to bury.
    expect(screen.getByText(/Previewing as you, signed in/i)).toBeInTheDocument();
  });

  /**
   * Authorizing an OAuth-backed MCP server navigates THIS frame (via
   * window.location.assign) and returns to /oauth/callback, which the
   * main.tsx self-embed exemption deliberately doesn't cover — the frame
   * would land on IframeRouterError. Hand the flow back to a real tab.
   */
  it("hands off to a browser tab when the frame navigates off the chatbox", () => {
    render(
      <ChatboxPreviewPane publishLink={sameOriginLink} mcpProfile={undefined} />,
    );

    const frame = screen.getByTestId("user-testing-preview-frame");
    // jsdom won't navigate for us; drive the load event with the frame
    // parked somewhere that isn't the chatbox runtime path.
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: { location: { pathname: "/oauth/callback" } },
    });
    fireEvent.load(frame);

    expect(
      screen.queryByTestId("user-testing-preview-frame"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/can't finish inside the preview/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /open in a new tab/i }),
    ).toHaveAttribute("href", sameOriginLink);
  });

  it("keeps the frame when a load lands back on the chatbox path", () => {
    render(
      <ChatboxPreviewPane publishLink={sameOriginLink} mcpProfile={undefined} />,
    );

    const frame = screen.getByTestId("user-testing-preview-frame");
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: { location: { pathname: "/chatbox/payments-beta/tok-1" } },
    });
    fireEvent.load(frame);

    expect(
      screen.getByTestId("user-testing-preview-frame"),
    ).toBeInTheDocument();
  });

  it("can reload back into the preview after a hand-off", () => {
    render(
      <ChatboxPreviewPane publishLink={sameOriginLink} mcpProfile={undefined} />,
    );

    const frame = screen.getByTestId("user-testing-preview-frame");
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: { location: { pathname: "/oauth/callback" } },
    });
    fireEvent.load(frame);

    fireEvent.click(screen.getByRole("button", { name: /reload preview/i }));

    expect(screen.getByTestId("user-testing-preview-frame")).toBeInTheDocument();
  });

  describe("remountKey", () => {
    // A rebind keeps the share link — same token, same slug — so `src` alone
    // can't tell the frame its configuration moved. The frame would go on
    // testing the pre-rebind setup with the bootstrap already in memory.
    // A key change is observable as a new DOM node: React tears the old
    // iframe down instead of reusing it, and the embed re-redeems on mount.
    it("remounts the frame when the bound environment changes", () => {
      const { rerender } = render(
        <ChatboxPreviewPane
          publishLink={sameOriginLink}
          mcpProfile={undefined}
          remountKey="env_a"
        />,
      );
      const before = screen.getByTestId("user-testing-preview-frame");

      rerender(
        <ChatboxPreviewPane
          publishLink={sameOriginLink}
          mcpProfile={undefined}
          remountKey="env_b"
        />,
      );

      expect(screen.getByTestId("user-testing-preview-frame")).not.toBe(before);
    });

    it("does NOT remount on unrelated prop churn", () => {
      const { rerender } = render(
        <ChatboxPreviewPane
          publishLink={sameOriginLink}
          mcpProfile={undefined}
          remountKey="env_a"
        />,
      );
      const before = screen.getByTestId("user-testing-preview-frame");

      rerender(
        <ChatboxPreviewPane
          publishLink={sameOriginLink}
          mcpProfile={undefined}
          remountKey="env_a"
          emptyTitle="a different empty-state title"
        />,
      );

      expect(screen.getByTestId("user-testing-preview-frame")).toBe(before);
    });

    it("omitting remountKey keeps the pre-existing src-only behavior", () => {
      const { rerender } = render(
        <ChatboxPreviewPane
          publishLink={sameOriginLink}
          mcpProfile={undefined}
        />,
      );
      const before = screen.getByTestId("user-testing-preview-frame");

      rerender(
        <ChatboxPreviewPane
          publishLink={sameOriginLink}
          mcpProfile={undefined}
        />,
      );

      expect(screen.getByTestId("user-testing-preview-frame")).toBe(before);
    });
  });
});
