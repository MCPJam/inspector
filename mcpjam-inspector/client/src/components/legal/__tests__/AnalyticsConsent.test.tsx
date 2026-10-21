import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
}));
vi.mock("posthog-js/react", () => ({ usePostHog: () => posthog }));
vi.mock("@/lib/PosthogUtils", () => ({ isPostHogDisabled: false }));

import {
  AnalyticsConsentBanner,
  AnalyticsConsentSetting,
} from "../AnalyticsConsent";

afterEach(() => {
  window.localStorage.clear();
});

it("asks once, then hides and opts out on Decline", () => {
  window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
  render(<AnalyticsConsentBanner />);
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  expect(posthog.opt_out_capturing).toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Analytics consent" })).toBeNull();
});

it("shows nothing where consent is not required", () => {
  window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = false;
  const { container } = render(
    <>
      <AnalyticsConsentBanner />
      <AnalyticsConsentSetting />
    </>,
  );
  expect(container).toBeEmptyDOMElement();
});

it("lets a visitor withdraw consent from Settings", () => {
  window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
  window.localStorage.setItem("mcpjam-analytics-consent", "granted");
  render(<AnalyticsConsentSetting />);
  const toggle = screen.getByRole("switch", {
    name: /Analytics and session replay/,
  });
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  expect(posthog.opt_out_capturing).toHaveBeenCalled();
  expect(toggle).not.toBeChecked();
});

it("lets a visitor who declined elsewhere turn analytics back on", () => {
  window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = false;
  window.localStorage.setItem("mcpjam-analytics-consent", "denied");
  render(<AnalyticsConsentSetting />);
  const toggle = screen.getByRole("switch", {
    name: /Analytics and session replay/,
  });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(posthog.opt_in_capturing).toHaveBeenCalledWith({
    captureEventName: false,
  });
  expect(toggle).toBeChecked();
});
