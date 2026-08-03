import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";

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

  it("marks a transport failure that never got a response", () => {
    // DNS / TLS / abort: `error` is set and there is NO response, so a
    // status-only test reads a dead connection as healthy. The body cannot
    // tell the reader either — no reply ever came back to log.
    const http = httpItem(CONFORMING);
    const payload = http.payload as { response?: unknown; error?: string };
    payload.response = undefined;
    payload.error = "fetch failed";

    render(<InlineFrameHeaders frame={FRAME} items={[FRAME, http]} />);

    expect(screen.getByText("3 MCP headers").className).toContain(
      "text-red-600",
    );
  });

  it("suppresses a legacy exchange whose headers carry no verdict", () => {
    // 2025-era: nothing is mirrored, so `evaluateMcpHeaders` returns
    // `Mcp-Session-Id` as `unchecked`. Rows exist but none judge anything, and
    // an inline disclosure would promise a cross-check it does not have. The
    // header is NOT lost — the dedicated HTTP row still renders it in full.
    const legacyFrame: CorrelatableLogItem = {
      ...FRAME,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "execute-sql" },
      },
    };
    const legacyHttp: CorrelatableLogItem = {
      ...httpItem({}),
      payload: {
        serverId: "srv-1",
        request: {
          method: "POST",
          url: "https://example.com/mcp",
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "sess-42",
          },
        },
        response: { status: 200, statusText: "OK", headers: {} },
        durationMs: 7,
        bodyValues: { method: "tools/call", name: "execute-sql" },
      },
    };

    const { container } = render(
      <InlineFrameHeaders
        frame={legacyFrame}
        items={[legacyFrame, legacyHttp]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("associates the toggle with the panel it controls", () => {
    render(
      <InlineFrameHeaders frame={FRAME} items={[FRAME, httpItem(CONFORMING)]} />,
    );

    const button = screen.getByRole("button");
    const panelId = button.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    // Collapsed: the id is declared but the panel is not in the tree yet.
    expect(document.getElementById(panelId!)).toBeNull();

    act(() => button.click());
    expect(document.getElementById(panelId!)).not.toBeNull();
  });

  /**
   * SEP-2243 `Mcp-Param-*` verdicts. The tool's declarations are recovered
   * from a `tools/list` RESULT already in the log — capture stores no request
   * bodies, so the arguments come from the correlated frame and the schema
   * from the listing, and neither requires a new capture channel.
   */
  describe("Mcp-Param-* verdicts", () => {
    const toolsListItem = (
      inputSchema: unknown,
      overrides: Partial<CorrelatableLogItem> = {},
    ): CorrelatableLogItem => ({
      id: "list-1",
      serverId: "srv-1",
      direction: "RECEIVE",
      timestamp: "2026-07-29T11:59:00.000Z",
      source: "mcp-server",
      payload: {
        jsonrpc: "2.0",
        id: 0,
        result: { tools: [{ name: "execute-sql", inputSchema }] },
      },
      ...overrides,
    });

    const DECLARING_SCHEMA = {
      type: "object",
      properties: { region: { type: "string", "x-mcp-header": "Region" } },
    };

    const openDetails = () => act(() => screen.getByRole("button").click());

    it("shows a mirrored param as matching the argument", () => {
      render(
        <InlineFrameHeaders
          frame={FRAME}
          items={[
            FRAME,
            toolsListItem(DECLARING_SCHEMA),
            httpItem({ ...CONFORMING, "mcp-param-region": "west" }),
          ]}
        />,
      );
      openDetails();
      // One row per mirrored header; the param's verdict is a real one now.
      expect(screen.getAllByText("✓ matches body").length).toBe(4);
    });

    it("names a param the client failed to mirror", () => {
      // The shape `toolParamHeaderMirroring: "omit"` puts on the wire.
      render(
        <InlineFrameHeaders
          frame={FRAME}
          items={[FRAME, toolsListItem(DECLARING_SCHEMA), httpItem(CONFORMING, 400)]}
        />,
      );
      expect(
        screen.getByText("Mcp-Param-Region disagrees with the body"),
      ).toBeTruthy();
      openDetails();
      expect(screen.getByText("✕ not sent, body says west → -32020")).toBeTruthy();
    });

    it("flags a param header the tool never declared", () => {
      render(
        <InlineFrameHeaders
          frame={FRAME}
          items={[
            FRAME,
            toolsListItem({ type: "object", properties: {} }),
            httpItem({ ...CONFORMING, "mcp-param-region": "west" }, 400),
          ]}
        />,
      );
      expect(
        screen.getByText("mcp-param-region is not declared by the tool"),
      ).toBeTruthy();
      openDetails();
      expect(
        screen.getByText("✕ not declared by the tool → -32020"),
      ).toBeTruthy();
    });

    it("says the schema is unavailable rather than implying a pass", () => {
      // No `tools/list` in the log: the param cannot be judged, and silence
      // would read as approval.
      render(
        <InlineFrameHeaders
          frame={FRAME}
          items={[FRAME, httpItem({ ...CONFORMING, "mcp-param-region": "west" })]}
        />,
      );
      openDetails();
      expect(
        screen.getByText("unchecked — tool schema unavailable"),
      ).toBeTruthy();
    });

    it("refuses to judge against a MALFORMED declaration", () => {
      // `x-mcp-header` under `oneOf` makes the whole tool definition invalid
      // (that is the conformance check's finding). Inventing per-header
      // verdicts from a schema just judged unusable would be worse than
      // saying nothing.
      render(
        <InlineFrameHeaders
          frame={FRAME}
          items={[
            FRAME,
            toolsListItem({
              type: "object",
              properties: {
                region: { oneOf: [{ type: "string", "x-mcp-header": "Region" }] },
              },
            }),
            httpItem({ ...CONFORMING, "mcp-param-region": "west" }),
          ]}
        />,
      );
      openDetails();
      expect(
        screen.getByText("unchecked — tool schema unavailable"),
      ).toBeTruthy();
    });

    it("ignores a listing captured AFTER the call — no future schema", () => {
      // A `list_changed` that lands moments after the call must not decide it.
      // The bound is strict: borrowing the correlator's 1s skew tolerance
      // (which exists for frame-vs-EXCHANGE pairing) would readmit exactly the
      // future schema this excludes, and turn a correct header into a false
      // "not declared by the tool".
      render(
        <InlineFrameHeaders
          frame={FRAME}
          items={[
            FRAME,
            toolsListItem(DECLARING_SCHEMA),
            // 300ms after the frame — inside a 1s slack, still the future.
            toolsListItem(
              { type: "object", properties: {} },
              { id: "list-later", timestamp: "2026-07-29T12:00:00.300Z" },
            ),
            httpItem({ ...CONFORMING, "mcp-param-region": "west" }),
          ]}
        />,
      );
      openDetails();
      // Judged against the schema in force AT the call: a match, not
      // "undeclared" from the listing that superseded it afterwards.
      expect(screen.getAllByText("✓ matches body").length).toBe(4);
    });

    it("reads the NEWEST listing when the tool schema changed mid-session", () => {
      render(
        <InlineFrameHeaders
          frame={FRAME}
          items={[
            FRAME,
            toolsListItem({ type: "object", properties: {} }),
            toolsListItem(DECLARING_SCHEMA, {
              id: "list-2",
              timestamp: "2026-07-29T11:59:30.000Z",
            }),
            httpItem({ ...CONFORMING, "mcp-param-region": "west" }),
          ]}
        />,
      );
      openDetails();
      expect(screen.getAllByText("✓ matches body").length).toBe(4);
    });
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
