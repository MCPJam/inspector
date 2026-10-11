/**
 * The classification sheet and its signals.
 *
 * The sheet is a suggestion, so its failure mode is not "wrong grade" but
 * "noise a submitter learns to ignore". The tests weight the near-misses —
 * `get_booking`, `add_book`, `buy_item` — as heavily as the hits.
 */

import { describe, expect, it } from "vitest";

import {
  buildMuseClassificationSheet,
  concealedWriteSignals,
  financialActionSignals,
  formatMuseClassificationSheet,
  sensitiveWriteSignals,
  suggestMuseToolClass,
  type MuseToolEvidence,
} from "../../src/muse-readiness/classification.js";

function tool(
  name: string,
  overrides: Partial<MuseToolEvidence> = {}
): MuseToolEvidence {
  return {
    name,
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

describe("suggestMuseToolClass", () => {
  it("reads readOnlyHint: true as a read", () => {
    const row = suggestMuseToolClass(
      tool("search_rooms", { annotations: { readOnlyHint: true } })
    );
    expect(row).toMatchObject({ suggested: "read", basis: "annotation" });
  });

  it("treats an absent hint as a write, because MCP's default is not read-only", () => {
    const row = suggestMuseToolClass(tool("search_rooms"));
    expect(row).toMatchObject({ suggested: "write", basis: "default" });
  });

  it("classifies a combined tool as a write even when it claims read-only (§3.2)", () => {
    const row = suggestMuseToolClass(
      tool("manage_rooms", {
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: { action: { type: "string", enum: ["list", "delete"] } },
        },
      })
    );
    expect(row).toMatchObject({
      suggested: "write",
      basis: "combined-operations",
    });
  });

  it("raises a write with a payment or message signal to a sensitive write", () => {
    expect(
      suggestMuseToolClass(
        tool("send_email", { annotations: { readOnlyHint: false } })
      ).suggested
    ).toBe("sensitive-write");
    expect(
      suggestMuseToolClass(
        tool("create_reservation", {
          description: "Books the room and charges the card on file.",
        })
      ).suggested
    ).toBe("sensitive-write");
  });

  it("raises a destructive write to a sensitive write", () => {
    const row = suggestMuseToolClass(
      tool("delete_account", {
        annotations: { readOnlyHint: false, destructiveHint: true },
      })
    );
    expect(row.suggested).toBe("sensitive-write");
    expect(row.reasons.join(" ")).toContain("destructiveHint");
  });

  it("never raises a READ, whatever its name says", () => {
    expect(
      suggestMuseToolClass(
        tool("list_payments", { annotations: { readOnlyHint: true } })
      ).suggested
    ).toBe("read");
  });

  it("keeps a declared class beside the suggestion rather than overwriting it", () => {
    const row = suggestMuseToolClass(
      tool("send_email", { annotations: { readOnlyHint: false } }),
      "write"
    );
    expect(row).toMatchObject({
      suggested: "sensitive-write",
      declared: "write",
    });
  });
});

describe("sensitiveWriteSignals — nouns that are not actions stay quiet", () => {
  it.each(["add_book", "update_sort_order", "create_post_draft_label"])(
    "%s does not count `book`/`order` as an action outside the leading position",
    (name) => {
      const signals = sensitiveWriteSignals(tool(name));
      expect(signals.filter((signal) => /book"|order"/.test(signal))).toEqual(
        []
      );
    }
  );

  it("counts a leading action verb", () => {
    expect(sensitiveWriteSignals(tool("book_room"))).toEqual([
      'name contains "book"',
    ]);
  });
});

describe("concealedWriteSignals", () => {
  it("flags a read whose name leads with an action verb", () => {
    expect(concealedWriteSignals(tool("send_digest"))).toEqual([
      'name starts with the action verb "send"',
    ]);
  });

  it("flags a read whose description states an action outright", () => {
    expect(
      concealedWriteSignals(
        tool("get_quote", {
          description: "Gets a quote, then places an order.",
        })
      )
    ).toEqual(['description says "places an order"']);
  });

  it.each([
    ["get_booking", "Returns the booking with its charges."],
    ["list_payments", "Lists recent payments and orders."],
    ["search_messages", "Search sent messages."],
  ])("does not flag %s", (name, description) => {
    expect(concealedWriteSignals(tool(name, { description }))).toEqual([]);
  });
});

describe("financialActionSignals (§4.6)", () => {
  it("flags a transfer between accounts", () => {
    expect(
      financialActionSignals(
        tool("transfer_funds", {
          description: "Moves money between your bank accounts.",
        })
      ).length
    ).toBeGreaterThan(0);
  });

  it("flags a trade order by its ticker parameter", () => {
    const signals = financialActionSignals(
      tool("place_order", {
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            quantity: { type: "number" },
          },
        },
      })
    );
    expect(signals).toEqual([
      'trade order: name has "order" and takes a "symbol" parameter',
    ]);
  });

  it("does not flag e-commerce: a buy verb without a financial instrument", () => {
    expect(
      financialActionSignals(
        tool("buy_item", { description: "Buy an item from the store." })
      )
    ).toEqual([]);
  });

  it("does not flag reading financial data, which §4.6 allows", () => {
    expect(
      financialActionSignals(
        tool("get_portfolio", {
          description: "Returns stock positions and balances.",
        })
      )
    ).toEqual([]);
  });
});

describe("formatMuseClassificationSheet", () => {
  it("renders the declared class when there is one, and says when it disagrees", () => {
    const sheet = buildMuseClassificationSheet(
      [
        tool("search_rooms", { annotations: { readOnlyHint: true } }),
        tool("send_email", { annotations: { readOnlyHint: false } }),
      ],
      { send_email: "write" }
    );
    const table = formatMuseClassificationSheet(sheet);
    expect(table.split("\n")).toEqual([
      "| Tool | Classification | Basis |",
      "| --- | --- | --- |",
      "| `search_rooms` | Read | suggested: declares readOnlyHint: true |",
      '| `send_email` | Write | declared; suggested Sensitive write: declares readOnlyHint: false; name contains "send", "email" |',
    ]);
  });

  it("escapes a pipe in a tool name so the table cannot break", () => {
    const table = formatMuseClassificationSheet(
      buildMuseClassificationSheet([tool("a|b")])
    );
    expect(table).toContain("`a\\|b`");
  });

  it("does not read a declared class off Object.prototype", () => {
    const [row] = buildMuseClassificationSheet([tool("constructor")], {});
    expect(row!.declared).toBeUndefined();
  });
});
