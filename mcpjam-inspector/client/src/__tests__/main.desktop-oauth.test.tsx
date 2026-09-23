import { act, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const bootstrap = vi.hoisted(() => vi.fn());
vi.mock("../app-bootstrap", () => {
  bootstrap();
  return {};
});
vi.mock("../lib/install-failed-request-tracker", () => ({}));
import { resetDesktopReturnAttemptsForTests } from "../components/oauth/OAuthDesktopReturnNotice";
beforeEach(() => {
  vi.resetModules();
  bootstrap.mockClear();
  window.isElectron = false;
  document.body.innerHTML = '<div id="root"></div>';
  resetDesktopReturnAttemptsForTests();
});
it("renders only the desktop return page without loading the application providers", async () => {
  window.history.replaceState(
    {},
    "",
    "/oauth/callback?code=test&state=electron_mcp%3Aone",
  );
  // Use a module mock so resetModules and main share the same redirect spy.
  const redirect = vi.fn();
  vi.doMock("../components/oauth/OAuthDesktopReturnNotice", async () => {
    const actual = await vi.importActual<
      typeof import("../components/oauth/OAuthDesktopReturnNotice")
    >("../components/oauth/OAuthDesktopReturnNotice");
    actual.desktopReturnRuntime.redirect = redirect;
    return actual;
  });
  await act(async () => {
    await import("../main");
  });
  expect(screen.getByText("Continue in MCPJam Desktop")).toBeTruthy();
  expect(screen.getByRole("link").getAttribute("href")).toContain(
    "mcpjam://oauth/callback",
  );
  expect(redirect).toHaveBeenCalledTimes(1);
  expect(bootstrap).not.toHaveBeenCalled();
});
it("keeps regular browser and WorkOS callbacks in the app bootstrap", async () => {
  window.history.replaceState({}, "", "/callback?code=test&state=workos");
  await act(async () => {
    await import("../main");
  });
  expect(bootstrap).toHaveBeenCalledOnce();
});
