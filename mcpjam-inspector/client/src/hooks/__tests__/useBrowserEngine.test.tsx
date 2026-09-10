import { beforeEach, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
const state = vi.hoisted(() => ({
  hosted: false,
  flag: true,
  granted: false,
  browserAvailable: true,
}));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useLocalBrowserEnabled: () => state.flag,
}));
vi.mock("@/hooks/useProjectComputer", () => ({
  useComputersDataPlaneConfig: () => ({
    engines: {
      local: {
        available: false,
        terminalAvailable: false,
        browserAvailable: state.browserAvailable,
      },
      cloud: { available: true },
    },
  }),
}));
vi.mock("@/hooks/useLocalBrowserConsent", () => ({
  useLocalBrowserConsent: () => ({
    granted: state.granted,
    token: state.granted ? "browser-token" : null,
  }),
}));
import { useBrowserEngine } from "../useBrowserEngine";
import { saveComputerEngine } from "@/lib/computer-engine-storage";
beforeEach(() => {
  localStorage.clear();
  state.hosted = false;
  state.flag = true;
  state.granted = false;
  state.browserAvailable = true;
});
it("defaults to This machine without shell availability or Browser consent", () => {
  const { result } = renderHook(() => useBrowserEngine("p"));
  expect(result.current.selectedEngine).toBe("local");
  expect(result.current.engine).toBe("local");
  expect(result.current.localAvailable).toBe(true);
});
it("stores Browser selection independently of shell selection and per project", () => {
  saveComputerEngine("p", "cloud");
  const { result, rerender } = renderHook(
    ({ project }) => useBrowserEngine(project),
    { initialProps: { project: "p" } },
  );
  expect(result.current.engine).toBe("local");
  act(() => result.current.setEngine("cloud"));
  expect(result.current.engine).toBe("cloud");
  rerender({ project: "other" });
  expect(result.current.engine).toBe("local");
});
it("keeps an explicit local selection when readiness is lost", () => {
  const { result, rerender } = renderHook(() => useBrowserEngine("p"));
  act(() => result.current.setEngine("local"));
  state.browserAvailable = false;
  rerender();
  expect(result.current.engine).toBe("local");
  expect(result.current.localAvailable).toBe(false);
});
it("hosted always selects Cloud and never offers local", () => {
  state.hosted = true;
  const { result } = renderHook(() => useBrowserEngine("p"));
  expect(result.current.engine).toBe("cloud");
  expect(result.current.localAvailable).toBe(false);
});
it("Browser candidacy uses its own flag", () => {
  state.flag = false;
  const { result } = renderHook(() => useBrowserEngine("p"));
  expect(result.current.localAvailable).toBe(false);
});
