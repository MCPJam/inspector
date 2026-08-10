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
import { render, screen } from "@testing-library/react";
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
});
