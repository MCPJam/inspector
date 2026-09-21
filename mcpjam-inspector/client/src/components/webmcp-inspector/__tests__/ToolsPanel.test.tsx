/**
 * The tools list, and what its badges promise.
 *
 * Badges are the one place the product SHOWS a page's claims about its own
 * tools, so what each tooltip says is a product decision, not styling: it has
 * to separate "the page said this" from "the product checked this", and — for
 * `consequential` — from "this browser build does not report it at all".
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ToolsPanel } from "../ToolsPanel";
import type { WebMcpToolDescriptor } from "@/shared/webmcp-inspector-protocol";

function tool(over: Partial<WebMcpToolDescriptor> = {}): WebMcpToolDescriptor {
  return {
    toolKey: "https://shop.test::submit_order",
    name: "submit_order",
    origin: "https://shop.test",
    fromSubframe: false,
    description: "Places an order",
    registrationKind: "imperative",
    ...over,
  };
}

function show(tools: WebMcpToolDescriptor[]) {
  render(
    <ToolsPanel
      tools={tools}
      selectedToolKey={undefined}
      onSelect={vi.fn()}
      hasSession
    />,
  );
}

describe("ToolsPanel — annotation badges", () => {
  it("shows a page's read-only claim AS a claim", () => {
    show([tool({ annotations: { readOnly: true } })]);
    const badge = screen.getByText("read-only");
    // The browser carries the page's `readOnlyHint` through faithfully, so the
    // tooltip does not hedge about whether we HEARD it. What it says is that
    // hearing it does not make it true, and that approval does not rest on it.
    expect(badge.getAttribute("title")).toMatch(/claim, not a guarantee/i);
    expect(badge.getAttribute("title")).toMatch(/still ask/i);
  });

  it("says out loud that `consequential` is not reported by the pinned build", () => {
    show([tool({ annotations: { consequential: true } })]);
    // Without this, an absent badge reads as "the page did not claim it" — and
    // at this Chromium version the page cannot make that claim reach us at all.
    expect(screen.getByText("consequential").getAttribute("title")).toMatch(
      /does not report this annotation/i,
    );
  });

  it("explains what autosubmit means for someone about to invoke", () => {
    show([
      tool({
        registrationKind: "declarative",
        annotations: { autosubmit: true },
      }),
    ]);
    expect(screen.getByText("autosubmit").getAttribute("title")).toMatch(
      /submits the form/i,
    );
    expect(screen.getByText("declarative").getAttribute("title")).toMatch(
      /derived by the browser/i,
    );
  });

  it("tells a developer that a subframe of another origin is a separate process", () => {
    show([
      tool({
        toolKey: "https://widget.test::sub_tool",
        name: "sub_tool",
        origin: "https://widget.test",
        fromSubframe: true,
      }),
    ]);
    // The case a developer needs to know about: their page's tool list now
    // includes a third party's, inspected through a session of its own.
    expect(screen.getByText("subframe").getAttribute("title")).toMatch(
      /cross-origin frame running in its own process/i,
    );
  });

  it("groups a cross-origin frame's tools under their own origin", () => {
    show([
      tool(),
      tool({
        toolKey: "https://widget.test::sub_tool",
        name: "sub_tool",
        origin: "https://widget.test",
        fromSubframe: true,
      }),
    ]);
    // Two publishers, two headings — which is the first thing worth knowing
    // about a tool an agent might call.
    const shop = screen.getByText("https://shop.test").closest("section")!;
    const widget = screen.getByText("https://widget.test").closest("section")!;
    expect(within(shop).getByText("submit_order")).toBeTruthy();
    expect(within(widget).getByText("sub_tool")).toBeTruthy();
  });

  it("shows no badges at all for a plain main-frame tool", () => {
    show([tool()]);
    expect(screen.queryByText("read-only")).toBeNull();
    expect(screen.queryByText("subframe")).toBeNull();
    expect(screen.queryByText("declarative")).toBeNull();
  });
});
