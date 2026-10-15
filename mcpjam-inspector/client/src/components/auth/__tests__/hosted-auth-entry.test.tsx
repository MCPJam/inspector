import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostedAuthEntry } from "../hosted-auth-entry";

const auth = vi.hoisted(() => ({
  user: null,
  isLoading: false,
  signIn: vi.fn(),
}));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => auth }));
const mountAppProviders = vi.fn();
function UnavailableAppSession() {
  mountAppProviders();
  return <p>Guest sessions exhausted; app cannot mount</p>;
}
beforeEach(() => {
  auth.signIn.mockReset();
  auth.isLoading = false;
  mountAppProviders.mockClear();
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});
it.each(["/login", "/login/"])(
  "starts SSO at %s without an app or guest session",
  async (path) => {
    const organizationId = "org_01M0E5C441JER65ZH0VBF8Y32Y";
    window.history.replaceState(
      {},
      "",
      `${path}?organization_id=${organizationId}`,
    );
    render(
      <HostedAuthEntry>
        <UnavailableAppSession />
      </HostedAuthEntry>,
    );
    await waitFor(() =>
      expect(auth.signIn).toHaveBeenCalledExactlyOnceWith({ organizationId }),
    );
    expect(mountAppProviders).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/Guest sessions exhausted/),
    ).not.toBeInTheDocument();
  },
);
it("waits for AuthKit, without starting guest authentication", async () => {
  window.history.replaceState({}, "", "/login");
  auth.isLoading = true;
  const view = render(
    <HostedAuthEntry>
      <UnavailableAppSession />
    </HostedAuthEntry>,
  );
  expect(auth.signIn).not.toHaveBeenCalled();
  expect(mountAppProviders).not.toHaveBeenCalled();
  auth.isLoading = false;
  view.rerender(
    <HostedAuthEntry>
      <UnavailableAppSession />
    </HostedAuthEntry>,
  );
  await waitFor(() => expect(auth.signIn).toHaveBeenCalledOnce());
});
it.each(["/", "/home", "/callback", "/login/other", "/p/project/login"])(
  "preserves app authentication for %s",
  (path) => {
    window.history.replaceState({}, "", path);
    render(
      <HostedAuthEntry>
        <UnavailableAppSession />
      </HostedAuthEntry>,
    );
    expect(mountAppProviders).toHaveBeenCalledOnce();
    expect(auth.signIn).not.toHaveBeenCalled();
  },
);
