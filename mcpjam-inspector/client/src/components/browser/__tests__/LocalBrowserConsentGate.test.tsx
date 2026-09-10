import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LocalBrowserConsentGate } from "../LocalBrowserConsentGate";

const mode = vi.hoisted(() => ({ hosted: false, guest: false }));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: mode.guest ? null : { id: "member" } }),
}));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return mode.hosted;
  },
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

beforeEach(() => {
  mode.hosted = false;
  mode.guest = false;
});
describe("LocalBrowserConsentGate", () => {
  it("explains device-wide guest access without promising shared project changes", () => {
    mode.guest = true;
    render(<LocalBrowserConsentGate onAllow={() => true} />);
    expect(
      screen.getByText(
        /your local clients across WebMCP, Playground, and tabs/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/projects you manage/)).toBeNull();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });
  it("explains device access and shared scope before any action", () => {
    const onAllow = vi.fn(() => true);
    render(<LocalBrowserConsentGate onAllow={onAllow} />);
    expect(
      screen.getByRole("heading", {
        name: "Enable local Browser for all clients",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Page content may be sent to your model/),
    ).toHaveTextContent(
      "all clients in projects you manage, including shared clients",
    );
    expect(
      screen.getByText(/each client's Connect settings/),
    ).toBeInTheDocument();
    expect(onAllow).not.toHaveBeenCalled();
  });

  it("requires Allow and reports failed setup for an explicit retry", async () => {
    const onAllow = vi
      .fn()
      .mockRejectedValue(
        new Error("Clients could not be enabled. Retry setup."),
      );
    render(<LocalBrowserConsentGate onAllow={onAllow} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByTestId("consent-error")).toHaveTextContent(
      "Retry setup",
    );
    expect(onAllow).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  it("never renders the permission in hosted mode", () => {
    mode.hosted = true;
    const onAllow = vi.fn();
    const { container } = render(<LocalBrowserConsentGate onAllow={onAllow} />);
    expect(container).toBeEmptyDOMElement();
    expect(onAllow).not.toHaveBeenCalled();
  });
});
