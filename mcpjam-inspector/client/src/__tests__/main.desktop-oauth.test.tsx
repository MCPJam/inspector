import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const bootstrap = vi.hoisted(() => vi.fn());
const reportCaught = vi.hoisted(() => vi.fn());
vi.mock("../lib/install-failed-request-tracker", () => ({}));
import { resetDesktopReturnAttemptsForTests } from "../components/oauth/OAuthDesktopReturnNotice";
beforeEach(() => {
  vi.resetModules();
  bootstrap.mockReset();
  reportCaught.mockReset();
  vi.doMock("../app-bootstrap", () => {
    bootstrap();
    return {};
  });
  vi.doMock("../lib/error-reporting", () => ({ reportCaught }));
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
  expect(screen.getByRole("img", { name: "MCPJam" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
});

it.each([false, true])(
  "shows reload recovery when bootstrap fails (reporting unavailable: %s)",
  async (reportingUnavailable) => {
    window.history.replaceState({}, "", "/servers");
    bootstrap.mockImplementation(() => {
      throw new Error("Failed to fetch app chunk");
    });
    if (reportingUnavailable) {
      vi.doMock("../lib/error-reporting", () => {
        throw new Error("Offline");
      });
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        await import("../main");
      });
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "MCPJam couldn't load",
      );
      expect(
        screen.getByRole("button", { name: "Reload MCPJam" }),
      ).toBeEnabled();
      expect(logged).toHaveBeenCalledWith(
        "MCPJam app bootstrap failed",
        expect.any(Error),
      );
      if (!reportingUnavailable) {
        await waitFor(() =>
          expect(reportCaught).toHaveBeenCalledWith(expect.any(Error), {
            source: "app_bootstrap",
          }),
        );
      }
    } finally {
      logged.mockRestore();
    }
  },
);
