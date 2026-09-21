import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { LaunchedCaseJudge } from "../case-scorecard/launched-case-judge";
const request = vi.hoisted(() => vi.fn());
vi.mock("convex/react", () => ({
  useMutation: () => request,
  useQuery: () => ({ status: "completed" }),
}));
it("never requests paid grading when a run mounts or remounts", () => {
  const view = render(
    <StrictMode>
      <LaunchedCaseJudge runId="run" />
    </StrictMode>,
  );
  view.rerender(<LaunchedCaseJudge runId="other-run" />);
  expect(request).not.toHaveBeenCalled();
});
