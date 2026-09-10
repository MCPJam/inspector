import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import {
  loadBrowserEngine,
  saveBrowserEngine,
} from "@/lib/browser-engine-storage";
import { beforeEach, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
const state = vi.hoisted(() => ({
  environment: false,
  hosted: false,
  flag: true,
  hostedFlag: false,
  member: true,
  granted: false,
  browserAvailable: true,
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: state.member ? { id: "member" } : null }),
}));
vi.mock("@/hooks/use-previewed-environment-id", () => ({
  usePreviewedEnvironmentId: () => [state.environment ? "env-1" : null],
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useLocalBrowserEnabled: () => state.flag,
  useHostedBrowserEnabled: () => state.hostedFlag,
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
  state.environment = false;
  useActiveChatSessionStore.setState({
    sessionId: null,
    browserLocation: null,
  });
  state.hosted = false;
  state.flag = true;
  state.hostedFlag = false;
  state.member = true;
  state.granted = false;
  state.browserAvailable = true;
});
it("defaults to This machine without shell availability or Browser consent", () => {
  const { result } = renderHook(() => useBrowserEngine("p"));
  expect(result.current.selectedEngine).toBe("local");
  expect(result.current.engine).toBe("local");
  expect(result.current.localAvailable).toBe(true);
  expect(result.current.cloudAvailable).toBe(false);
});
it("keeps local Browser available to guests but never offers cloud", () => {
  state.member = false;
  state.hostedFlag = true;
  const { result } = renderHook(() => useBrowserEngine("p"));
  expect(result.current.localAvailable).toBe(true);
  expect(result.current.cloudAvailable).toBe(false);
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
it("the rollout flag does not misreport server availability", () => {
  state.flag = false;
  const { result } = renderHook(() => useBrowserEngine("p"));
  expect(result.current.localAvailable).toBe(true);
});

it("defaults to Cloud outside the cohort but allows explicit local onboarding", () => {
  state.flag = false;
  const { result } = renderHook(() => useBrowserEngine("p"));
  expect(result.current.engine).toBe("cloud");
  act(() => result.current.setEngine("local"));
  expect(result.current.engine).toBe("local");
  expect(result.current.localAvailable).toBe(true);
});
it("environment mode shows Cloud and does not overwrite the device preference", () => {
  saveBrowserEngine("p", "local");
  state.environment = true;
  const { result, rerender } = renderHook(() => useBrowserEngine("p"));
  expect(result.current.engine).toBe("cloud");
  expect(result.current.toggleVisible).toBe(false);
  act(() => result.current.setEngine("cloud"));
  expect(loadBrowserEngine("p")).toBe("local");
  state.environment = false;
  rerender();
  expect(result.current.engine).toBe("local");
});
it("resuming Cloud affects only that conversation and leaves new chats local", () => {
  saveBrowserEngine("p", "local");
  useActiveChatSessionStore.setState({
    sessionId: "old-chat",
    browserLocation: { projectId: "p", sessionId: "old-chat", engine: "cloud" },
  });
  const { result } = renderHook(() => useBrowserEngine("p"));
  expect(result.current.engine).toBe("cloud");
  expect(loadBrowserEngine("p")).toBe("local");
  act(() => useActiveChatSessionStore.getState().setSessionId("new-chat"));
  expect(result.current.engine).toBe("local");
});

it("personal preferences ignore an environment's forced location and a bound chat", () => {
  saveBrowserEngine("p", "local");
  state.environment = true;
  useActiveChatSessionStore.setState({ sessionId: "old-chat", browserLocation: { projectId: "p", sessionId: "old-chat", engine: "cloud" } });
  const { result } = renderHook(() => useBrowserEngine("p", "preference"));
  expect(result.current.selectedEngine).toBe("local");
  act(() => result.current.setEngine("cloud"));
  expect(loadBrowserEngine("p")).toBe("cloud");
});
