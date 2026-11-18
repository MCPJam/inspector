/** Step builders and case shapes shared by the steps editor's model tests. */
import type { Predicate } from "@/shared/eval-matching";
import type { InteractStep, TestStep } from "@/shared/steps";

export const prompt = (id: string, text = "ask"): TestStep => ({
  id,
  kind: "prompt",
  prompt: text,
});
export const check = (
  id: string,
  assertion: Predicate = { type: "noToolErrors" },
) => ({ id, kind: "assert", assertion }) satisfies TestStep;
export const interact = (
  id: string,
  action: InteractStep["action"] = { kind: "click", target: { testId: "x" } },
  toolName = "cart_view",
): TestStep => ({ id, kind: "interact", toolName, action });
export const tool = (id: string, toolName = "get_me"): TestStep => ({
  id,
  kind: "toolCall",
  serverName: "accounts",
  toolName,
  arguments: {},
});
export const toolAssert = (id: string, toolName: string) =>
  check(id, { type: "toolCalledWith", toolName, args: { args: {} } });

export const FIXTURES: [string, TestStep[]][] = [
  ["no steps", []],
  ["[p]", [prompt("p")]],
  ["[a]", [check("a")]],
  ["[a, p, a]", [check("a0"), prompt("p"), check("a1")]],
  [
    "[p, a, i, a, a, t]",
    [
      prompt("p"),
      check("a1"),
      interact("i"),
      check("a2"),
      check("a3"),
      tool("t"),
    ],
  ],
  ["[p, p]", [prompt("p1"), prompt("p2")]],
  ["[t, a]", [tool("t"), check("a")]],
];
