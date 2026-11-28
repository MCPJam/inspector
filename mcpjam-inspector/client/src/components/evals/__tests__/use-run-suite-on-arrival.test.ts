import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useRunSuiteOnArrival } from "../use-run-suite-on-arrival";

const navigate = vi.fn();
let search = "";
vi.mock("@/lib/app-navigation", () => ({
  EVAL_RUN_PARAM: "run",
  useAppNavigate: () => navigate,
  useCurrentLocationParts: () => ({
    pathname: "/evaluate/suite/s1",
    search,
    hash: "",
  }),
}));

beforeEach(() => {
  navigate.mockReset();
});

it("opens one run review and drops the key once the page is ready", () => {
  search = "?run=s1&view=cases";
  const run = vi.fn();
  const { rerender } = renderHook(
    ({ ready }) => useRunSuiteOnArrival(ready, run),
    { initialProps: { ready: false } },
  );
  expect(run).not.toHaveBeenCalled();
  rerender({ ready: true });
  rerender({ ready: true });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith("s1");
  expect(navigate).toHaveBeenCalledWith("/evaluate/suite/s1?view=cases", {
    replace: true,
  });
});

it("does nothing without the key", () => {
  search = "";
  const run = vi.fn();
  renderHook(() => useRunSuiteOnArrival(true, run));
  expect(run).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});
