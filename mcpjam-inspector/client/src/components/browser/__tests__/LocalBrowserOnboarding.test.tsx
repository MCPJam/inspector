import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { LocalBrowserOnboarding } from "../LocalBrowserOnboarding";
import {
  localBrowserOnboardingDecision,
  clearStoredLocalBrowserConsent,
} from "@/lib/local-browser-consent";

const state = vi.hoisted(() => ({
  hosted: false,
  enabled: true,
  available: true,
  resolved: true,
  environment: false,
  guest: false,
  engine: "local",
  request: vi.fn(),
}));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: state.request }));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: state.guest ? null : { id: "member" } }),
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useLocalBrowserEnabled: () => state.enabled,
}));
vi.mock("@/hooks/useBrowserEngine", async () => {
  const { useLocalBrowserConsent } = await import(
    "@/hooks/useLocalBrowserConsent"
  );
  return {
    useBrowserEngine: () => ({
      resolved: state.resolved,
      localAvailable: state.available,
      environmentMode: state.environment,
      selectedEngine: state.engine,
      consent: useLocalBrowserConsent(),
    }),
  };
});

beforeEach(() => {
  localStorage.clear();
  Object.assign(state, {
    hosted: false,
    enabled: true,
    available: true,
    resolved: true,
    environment: false,
    guest: false,
    engine: "local",
  });
  state.request
    .mockReset()
    .mockImplementation(async (url: string) =>
      Response.json(
        url.endsWith("/grant")
          ? { token: "device-consent-test-token", grantedAt: "now" }
          : url.endsWith("/verify")
          ? { valid: true }
          : { enabledProjects: 1, skippedProjects: 0 },
      ),
    );
});

it("shows a centered decision over an existing conversation without requiring a client or server", () => {
  render(
    <>
      <p>Existing conversation</p>
      <LocalBrowserOnboarding projectId={null} authReady />
    </>,
  );
  expect(
    screen.getByRole("dialog", { name: "Let agents use your browser?" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Existing conversation")).toBeInTheDocument();
  expect(state.request).not.toHaveBeenCalled();
});

it.each(["Not now", "Close", "Escape"])(
  "remembers %s across remounts without granting permission",
  (action) => {
    const view = render(
      <LocalBrowserOnboarding projectId="project" authReady />,
    );
    if (action === "Escape")
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    else fireEvent.click(screen.getByRole("button", { name: action }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(localBrowserOnboardingDecision()).toBe("dismissed");
    view.unmount();
    render(<LocalBrowserOnboarding projectId="another-project" authReady />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.request).not.toHaveBeenCalled();
  },
);

it("finishes permission and client setup before closing, and never starts the browser", async () => {
  let finish!: (value: Response) => void;
  state.request.mockImplementation(async (url: string) =>
    url.endsWith("/grant")
      ? Response.json({ token: "device-consent-test-token", grantedAt: "now" })
      : new Promise<Response>((resolve) => {
          finish = resolve;
        }),
  );
  render(<LocalBrowserOnboarding projectId={null} authReady />);
  fireEvent.click(screen.getByRole("button", { name: "Allow browser access" }));
  await waitFor(() => expect(state.request).toHaveBeenCalledTimes(2));
  expect(
    screen.getByRole("button", { name: "Enabling browser…" }),
  ).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(localBrowserOnboardingDecision()).toBeNull();
  await act(async () =>
    finish(Response.json({ enabledProjects: 1, skippedProjects: 0 })),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(localBrowserOnboardingDecision()).toBe("completed");
  expect(state.request.mock.calls.map(([url]) => url)).toEqual([
    "/api/mcp/computers/local-browser/consent/grant",
    "/api/mcp/computers/local-browser/enable-clients",
  ]);
  act(() => clearStoredLocalBrowserConsent());
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps partial failures visible and retries with saved permission", async () => {
  state.request
    .mockResolvedValueOnce(
      Response.json({ token: "device-consent-test-token", grantedAt: "now" }),
    )
    .mockResolvedValueOnce(new Response("failed", { status: 503 }));
  render(<LocalBrowserOnboarding projectId="project" authReady />);
  fireEvent.click(screen.getByRole("button", { name: "Allow browser access" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "clients could not be enabled",
  );
  expect(localBrowserOnboardingDecision()).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    state.request.mock.calls.filter(([url]) => url.endsWith("/grant")),
  ).toHaveLength(1);
  expect(
    state.request.mock.calls.some(([url]) => url.endsWith("/verify")),
  ).toBe(true);
});

it("offers existing authorized users setup once, without silently changing settings", () => {
  localStorage.setItem(
    "mcp-local-browser-consent-v1",
    JSON.stringify({ token: "device-consent-test-token", grantedAt: "now" }),
  );
  render(<LocalBrowserOnboarding projectId="project" authReady />);
  expect(
    screen.getByRole("dialog", { name: "Finish enabling browser tools" }),
  ).toBeInTheDocument();
  expect(state.request).not.toHaveBeenCalled();
});

it.each([
  "hosted",
  "disabled",
  "unavailable",
  "loading",
  "environment",
  "cloud",
  "auth",
])("does not prompt when %s", (condition) => {
  if (condition === "hosted") state.hosted = true;
  if (condition === "disabled") state.enabled = false;
  if (condition === "unavailable") state.available = false;
  if (condition === "loading") state.resolved = false;
  if (condition === "environment") state.environment = true;
  if (condition === "cloud") state.engine = "cloud";
  render(
    <LocalBrowserOnboarding
      projectId="project"
      authReady={condition !== "auth"}
    />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(state.request).not.toHaveBeenCalled();
});

it("syncs dismissal from another tab", () => {
  render(<LocalBrowserOnboarding projectId="project" authReady />);
  act(() => {
    localStorage.setItem("mcp-local-browser-onboarding-v1", "dismissed");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "mcp-local-browser-onboarding-v1" }),
    );
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("explains device scope for guests", () => {
  state.guest = true;
  render(<LocalBrowserOnboarding projectId={null} authReady />);
  expect(
    screen.getByText(
      /your local clients across WebMCP, Playground, and tabs on this device/,
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText(/projects you manage/)).toBeNull();
});
