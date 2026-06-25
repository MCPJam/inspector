import { describe, expect, it } from "vitest";
import { buildAppToolInvocationsFromBrowserSteps } from "../widget-tool-calls-to-app-invocations";
import type { EvalTraceBrowserInteractionStepView } from "@/shared/eval-trace";

function step(
  partial: Partial<EvalTraceBrowserInteractionStepView> &
    Pick<EvalTraceBrowserInteractionStepView, "toolCallId" | "stepIndex" | "ts">
): EvalTraceBrowserInteractionStepView {
  return {
    action: "left_click",
    ok: true,
    elapsedMs: 0,
    ...partial,
  } as EvalTraceBrowserInteractionStepView;
}

describe("buildAppToolInvocationsFromBrowserSteps", () => {
  it("returns [] when no steps carry widget tool calls", () => {
    expect(buildAppToolInvocationsFromBrowserSteps([])).toEqual([]);
    expect(
      buildAppToolInvocationsFromBrowserSteps([
        step({ toolCallId: "t1", stepIndex: 0, ts: 1 }),
      ])
    ).toEqual([]);
  });

  it("maps a successful widget call to a success invocation with output", () => {
    const result = [
      buildAppToolInvocationsFromBrowserSteps([
        step({
          toolCallId: "search-1",
          stepIndex: 2,
          ts: 100,
          widgetToolCalls: [
            {
              name: "add-to-cart",
              args: { sku: "redbull" },
              ok: true,
              elapsedMs: 25,
              result: { content: [{ type: "text", text: "added" }] },
            },
          ],
        }),
      ]),
    ][0];

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "search-1:app-tool:2-0",
      parentToolCallId: "search-1",
      toolName: "add-to-cart",
      input: { sku: "redbull" },
      status: "success",
      output: { content: [{ type: "text", text: "added" }] },
      startedAt: 100,
      completedAt: 125,
    });
  });

  it("maps a failed call to error status with errorText and no output", () => {
    const [inv] = buildAppToolInvocationsFromBrowserSteps([
      step({
        toolCallId: "w-1",
        stepIndex: 0,
        ts: 5,
        widgetToolCalls: [
          {
            name: "checkout",
            args: {},
            ok: false,
            error: "out of stock",
            elapsedMs: 10,
            // result intentionally absent on the error path
          },
        ],
      }),
    ]);

    expect(inv.status).toBe("error");
    expect(inv.errorText).toBe("out of stock");
    expect(inv).not.toHaveProperty("output");
  });

  it("omits output for a legacy call with no recorded result", () => {
    const [inv] = buildAppToolInvocationsFromBrowserSteps([
      step({
        toolCallId: "w-1",
        stepIndex: 0,
        ts: 5,
        widgetToolCalls: [
          { name: "refresh", args: {}, ok: true, elapsedMs: 3 },
        ],
      }),
    ]);
    expect(inv.status).toBe("success");
    expect(inv).not.toHaveProperty("output");
  });

  it("coerces non-object args to no input", () => {
    const [inv] = buildAppToolInvocationsFromBrowserSteps([
      step({
        toolCallId: "w-1",
        stepIndex: 0,
        ts: 5,
        widgetToolCalls: [
          { name: "noop", args: ["not", "an", "object"], ok: true, elapsedMs: 1 },
        ],
      }),
    ]);
    expect(inv).not.toHaveProperty("input");
  });

  it("orders multiple calls under one parent by step then call index", () => {
    const invs = buildAppToolInvocationsFromBrowserSteps([
      step({
        toolCallId: "p",
        stepIndex: 1,
        ts: 50,
        widgetToolCalls: [
          { name: "first", args: {}, ok: true, elapsedMs: 1 },
          { name: "second", args: {}, ok: true, elapsedMs: 1 },
        ],
      }),
      step({
        toolCallId: "p",
        stepIndex: 0,
        ts: 40,
        widgetToolCalls: [{ name: "earlier", args: {}, ok: true, elapsedMs: 1 }],
      }),
    ]);
    // Sorted by ts (40 < 50) then stepIndex/callIndex within a ts.
    expect(invs.map((i) => i.toolName)).toEqual(["earlier", "first", "second"]);
    expect(invs.map((i) => i.id)).toEqual([
      "p:app-tool:0-0",
      "p:app-tool:1-0",
      "p:app-tool:1-1",
    ]);
  });
});
