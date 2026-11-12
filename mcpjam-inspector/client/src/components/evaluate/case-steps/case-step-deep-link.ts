/**
 * Opening the editor at one step: `?step=<preview key>`, sent by a test run's
 * execution preview. Only a key this draft actually has is honoured; anything
 * else is ignored without a message.
 */
import type { TestStep } from "@/shared/steps";
import { EVAL_NAV_STEP_PARAM } from "../test-run/test-run-links";

const SECTION_KEYS: ReadonlySet<string> = new Set(["outcome", "after-run"]);

/** "action:<id>" | "check:<id>" for an id in steps, "outcome" | "after-run", else null. */
export function readCaseStepParam(
  search: string,
  steps: TestStep[],
): string | null {
  const key = new URLSearchParams(search).get(EVAL_NAV_STEP_PARAM);
  if (!key) return null;
  if (SECTION_KEYS.has(key)) return key;
  const separator = key.indexOf(":");
  if (separator < 0) return null;
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  const step = steps.find((item) => item.id === id);
  if (!step) return null;
  if (kind === "check") return step.kind === "assert" ? key : null;
  if (kind === "action") return step.kind !== "assert" ? key : null;
  return null;
}
