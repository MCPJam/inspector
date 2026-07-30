import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { InlineFrameHeaders } from "../InlineFrameHeaders";
import type { CorrelatableLogItem } from "../correlate-http-exchange";

/**
 * The collapsed row is the whole point of the feature: a reader who opened a
 * frame to read its body must be told, without opening anything else, that the
 * headers it rode in disagree with that body. These assert what that row says.
 */

const FRAME: CorrelatableLogItem = {
  id: "frame-1",
  serverId: "srv-1",
  direction: "SEND",
  timestamp: "2026-07-29T12:00:00.000Z",
  source: "mcp-server",
  payload: {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "execute-sql",
      arguments: { region: "west" },
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    },
  },
};

function httpItem(
  headers: Record<string, string>,
  status = 200,
): CorrelatableLogItem {
  return {
    id: "http-1",
    serverId: "srv-1",
    direction: "HTTP",
    timestamp: "2026-07-29T12:00:00.200Z",
    source: "http",
    payload: {
      serverId: "srv-1",
      request: { method: "POST", url: "https://example.com/mcp", headers },
      response: { status, statusText: "", headers: {} },
      durationMs: 7,
      bodyValues: {
        method: "tools/call",
        name: "execute-sql",
        protocolVersion: "2026-07-28",
      },
    },
  };
}

const CONFORMING = {
  "mcp-protocol-version": "2026-07-28",
  "mcp-method": "tools/call",
  "mcp-name": "execute-sql",
};

describe("InlineFrameHeaders", () => {
  it("renders nothing when no exchange correlates", () => {
    const { container } = render(
      <InlineFrameHeaders frame={FRAME} items={[FRAME]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("summarizes a conforming exchange by count, collapsed", () => {
    const http = httpItem(CONFORMING);
    render(<InlineFrameHeaders frame={FRAME} items={[FRAME, http]} />);

    expect(screen.getByText("3 MCP headers")).toBeTruthy();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    // Collapsed means collapsed: the detail body is not rendered.
    expect(screen.queryByText("Response headers")).toBeNull();
  });

  it("names the disagreeing header on the collapsed row", () => {
    // `Mcp-Name` is REQUIRED on tools/call and the body says `execute-sql`.
    // Dropping it is the `-32020` case, and the reader must see it without
    // expanding anything.
    const { "mcp-name": _dropped, ...withoutName } = CONFORMING;
    render(
      <InlineFrameHeaders
        frame={FRAME}
        items={[FRAME, httpItem(withoutName, 400)]}
      />,
    );

    expect(screen.getByText("mcp-name disagrees with the body")).toBeTruthy();
  });

  it("counts multiple disagreements rather than naming one", () => {
    render(
      <InlineFrameHeaders
        frame={FRAME}
        items={[
          FRAME,
          httpItem({ "mcp-protocol-version": "2026-07-28" }, 400),
        ]}
      />,
    );

    expect(
      screen.getByText("2 headers disagree with the body"),
    ).toBeTruthy();
  });

  it("stays out of the way on a legacy exchange with no MCP headers", () => {
    const legacyFrame: CorrelatableLogItem = {
      ...FRAME,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} },
    };
    const legacyHttp: CorrelatableLogItem = {
      ...httpItem({}),
      payload: {
        serverId: "srv-1",
        request: {
          method: "POST",
          url: "https://example.com/mcp",
          headers: { "content-type": "application/json" },
        },
        response: { status: 200, statusText: "OK", headers: {} },
        durationMs: 7,
        bodyValues: { method: "tools/call" },
      },
    };

    const { container } = render(
      <InlineFrameHeaders frame={legacyFrame} items={[legacyFrame, legacyHttp]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
