import { describe, expect, it } from "vitest";
import { splitHttpEntriesForDisplay } from "../http-entry-views";

// The debuggers store one httpHistory entry per exchange, tagged with the
// REQUEST step. This helper decides, per entry, whether the logger renders it
// whole or splits it across the request card and the paired received card.

type Step = "req_a" | "recv_a" | "lonely";

const ORDER: Step[] = ["req_a", "recv_a", "lonely"];
const getStepIndex = (step: Step) => ORDER.indexOf(step);
const pairedReceivedStep = (step: Step): Step | undefined =>
  step === "req_a" ? "recv_a" : undefined;

interface Entry {
  step: Step;
  timestamp: number;
  duration?: number;
  request: { method: string; url: string };
  response?: { status: number };
  error?: { message: string };
}

const entry = (overrides: Partial<Entry> = {}): Entry => ({
  step: "req_a",
  timestamp: 1000,
  duration: 50,
  request: { method: "GET", url: "https://example.test" },
  response: { status: 200 },
  ...overrides,
});

const split = (entries: Entry[], reachedIndex: number) =>
  splitHttpEntriesForDisplay<Step, Entry>({
    entries,
    pairedReceivedStep,
    getStepIndex,
    reachedIndex,
  });

describe("splitHttpEntriesForDisplay", () => {
  it("splits a reached exchange into request + response items with derived timestamp", () => {
    const items = split([entry()], getStepIndex("recv_a"));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      step: "req_a",
      view: "request",
      timestamp: 1000,
    });
    expect(items[1]).toMatchObject({
      step: "recv_a",
      view: "response",
      timestamp: 1050, // arrival = timestamp + duration
    });
    // Same underlying entry, unmodified, on both items.
    expect(items[0].entry).toBe(items[1].entry);
  });

  it("keeps the exchange whole while the received step is not reached", () => {
    // Resting right after the request click, or parked with a flow error.
    const items = split([entry()], getStepIndex("req_a"));
    expect(items).toEqual([
      expect.objectContaining({ step: "req_a", view: "full" }),
    ]);
  });

  it("keeps errored exchanges whole on the request card", () => {
    const items = split(
      [entry({ error: { message: "boom" }, response: undefined })],
      getStepIndex("recv_a"),
    );
    expect(items).toEqual([
      expect.objectContaining({ step: "req_a", view: "full" }),
    ]);
  });

  it("renders a response-less entry as the request view (genuine pending)", () => {
    // OAuth's prepared-but-not-yet-sent rest.
    const items = split([entry({ response: undefined })], getStepIndex("req_a"));
    expect(items).toEqual([
      expect.objectContaining({ step: "req_a", view: "request" }),
    ]);
  });

  it("splits only the latest entry per step; earlier candidates stay whole", () => {
    // Multi-URL discovery: failed candidates are diagnostics.
    const failed = entry({ timestamp: 900, response: { status: 404 } });
    const succeeded = entry({ timestamp: 1000 });
    const items = split([failed, succeeded], getStepIndex("recv_a"));
    expect(items).toEqual([
      expect.objectContaining({ view: "full", entry: failed }),
      expect.objectContaining({ view: "request", entry: succeeded }),
      expect.objectContaining({ view: "response", entry: succeeded }),
    ]);
  });

  it("leaves unpaired steps whole", () => {
    const items = split(
      [entry({ step: "lonely" })],
      getStepIndex("lonely"),
    );
    expect(items).toEqual([
      expect.objectContaining({ step: "lonely", view: "full" }),
    ]);
  });
});
