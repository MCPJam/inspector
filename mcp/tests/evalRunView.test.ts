import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvalRunView } from "../src/ui/views/evals.js";

/**
 * `get_eval_run`'s widget tells the agent whether to poll again. A finished
 * run labelled "In progress" sends it back for a status that will never
 * change; a held or live run without the label lets it report a verdict that
 * does not exist yet.
 */
function render(status: string): string {
  return renderToStaticMarkup(
    createElement(EvalRunView, {
      isDark: false,
      payload: {
        project: { id: "p1", name: "Project" },
        run: {
          id: "run-1",
          suiteId: "suite-1",
          status,
          result: "pending",
          createdAt: 0,
        },
      } as never,
    }),
  );
}

describe("EvalRunView", () => {
  it.each(["completed", "failed", "cancelled", "timed_out"])(
    "does not call a %s run in progress",
    (status) => {
      expect(render(status)).not.toContain("In progress");
    },
  );

  it.each(["pending", "running", "grading"])(
    "tells the agent a %s run has not finished",
    (status) => {
      expect(render(status)).toContain("In progress");
    },
  );
});
