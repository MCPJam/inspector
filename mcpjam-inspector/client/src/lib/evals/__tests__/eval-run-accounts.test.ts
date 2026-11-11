import { describe, expect, it } from "vitest";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { EvalRunAccount } from "@/components/evals/types";
import {
  ranAsRole,
  runAccountsByServer,
  spanAccountName,
  toolCallAccountNames,
} from "../eval-run-accounts";


const live = {
  connectionId: "conn-live",
  name: "Live",
  isDefault: true,
  needsReauth: false,
};
const dummy = {
  connectionId: "conn-dummy",
  name: "Dummy",
  isDefault: false,
  needsReauth: false,
};

function asana(overrides: Partial<SuiteAccountsServer> = {}): SuiteAccountsServer {
  return {
    serverId: "srv-asana",
    mode: "accounts",
    accounts: [live, dummy],
    chosen: null,
    ...overrides,
  };
}

const names = (serverId: string) =>
  ({ "srv-asana": "Asana", "srv-linear": "Linear" })[serverId] ?? serverId;

describe("ranAsRole", () => {
  it("names the schedule's owner and the key's owner from the run's source", () => {
    expect(ranAsRole("schedule")).toBe("Schedule owner");
    expect(ranAsRole("api")).toBe("Key owner");
    expect(ranAsRole("sdk")).toBe("Key owner");
    expect(ranAsRole("ui")).toBeNull();
    expect(ranAsRole(undefined)).toBeNull();
  });
});

describe("trace account labels", () => {
  const accounts: EvalRunAccount[] = [
    { serverId: "srv-asana", kind: "account", connectionId: "conn-live", name: "Live" },
    { serverId: "srv-asana", kind: "account", connectionId: "conn-dummy", name: "Dummy" },
    { serverId: "srv-linear", kind: "account", connectionId: "conn-work", name: "Work" },
    { serverId: "srv-okta", kind: "xaa", name: "XAA", xaaSubject: "alice-test" },
  ];
  const tool = (span: Partial<EvalTraceSpan>): EvalTraceSpan => ({
    id: "tool-1",
    name: "asana_get_task",
    category: "tool",
    startMs: 0,
    endMs: 1,
    ...span,
  });

  it("resolves a span's connection id against the run's accounts", () => {
    expect(
      spanAccountName(tool({ connectionId: "conn-dummy", serverId: "srv-asana" }), accounts),
    ).toBe("Dummy");
    expect(spanAccountName(tool({ connectionId: "conn-unknown" }), accounts)).toBeUndefined();
  });

  it("falls back to the only account a server had when the span names none", () => {
    expect(spanAccountName(tool({ serverId: "srv-linear" }), accounts)).toBe("Work");
    // Two Asana accounts: a span without a connection id cannot be placed.
    expect(spanAccountName(tool({ serverId: "srv-asana" }), accounts)).toBeUndefined();
    expect(spanAccountName(tool({ serverId: "srv-okta" }), accounts)).toBe("alice-test");
  });

  it("labels only tool spans, and nothing for a run that recorded no accounts", () => {
    expect(
      spanAccountName(tool({ category: "llm", connectionId: "conn-dummy" }), accounts),
    ).toBeUndefined();
    expect(spanAccountName(tool({ connectionId: "conn-dummy" }), undefined)).toBeUndefined();
  });

  it("maps every labelled tool call by its id", () => {
    const map = toolCallAccountNames(
      [
        tool({ id: "a", toolCallId: "call-a", connectionId: "conn-live" }),
        tool({ id: "b", toolCallId: "call-b", serverId: "srv-asana" }),
        tool({ id: "c", connectionId: "conn-dummy" }),
      ],
      accounts,
    );
    expect([...map]).toEqual([["call-a", "Live"]]);
  });

  it("groups a run's accounts by server for the header", () => {
    expect(runAccountsByServer(accounts)).toEqual([
      { serverId: "srv-asana", names: ["Live", "Dummy"] },
      { serverId: "srv-linear", names: ["Work"] },
      { serverId: "srv-okta", names: ["alice-test"] },
    ]);
  });
});
