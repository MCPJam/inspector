import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewsletterConsentSwitch } from "../NewsletterConsentSwitch";

const { setMarketingOptIn, mutationNames } = vi.hoisted(() => ({
  setMarketingOptIn: vi.fn(),
  mutationNames: [] as string[],
}));

vi.mock("convex/react", () => ({
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    mutationNames.push(getFunctionName(ref));
    return setMarketingOptIn;
  },
}));

function newsletterSwitch() {
  return screen.getByRole("switch", {
    name: "Email me the MCPJam newsletter",
  });
}

describe("NewsletterConsentSwitch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationNames.length = 0;
    setMarketingOptIn.mockResolvedValue({ marketingOptIn: true });
  });

  it("is off when the account has not opted in", () => {
    render(<NewsletterConsentSwitch optedIn={false} loading={false} />);
    expect(newsletterSwitch()).not.toBeChecked();
    expect(setMarketingOptIn).not.toHaveBeenCalled();
  });

  it("is on only when the account opted in", () => {
    render(<NewsletterConsentSwitch optedIn loading={false} />);
    expect(newsletterSwitch()).toBeChecked();
  });

  it("cannot be changed while the account is loading", () => {
    render(<NewsletterConsentSwitch optedIn={false} loading />);
    expect(newsletterSwitch()).toBeDisabled();
  });

  it("records an opt-in through setMarketingOptIn", async () => {
    render(<NewsletterConsentSwitch optedIn={false} loading={false} />);
    fireEvent.click(newsletterSwitch());
    await waitFor(() =>
      expect(setMarketingOptIn).toHaveBeenCalledWith({ optIn: true }),
    );
    expect(mutationNames).toContain("marketingConsent:setMarketingOptIn");
    await waitFor(() => expect(newsletterSwitch()).toBeEnabled());
  });

  it("records an opt-out when an opted-in account turns it off", async () => {
    render(<NewsletterConsentSwitch optedIn loading={false} />);
    fireEvent.click(newsletterSwitch());
    await waitFor(() =>
      expect(setMarketingOptIn).toHaveBeenCalledWith({ optIn: false }),
    );
  });

  it("says the choice was not saved when the mutation fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setMarketingOptIn.mockRejectedValueOnce(new Error("offline"));
    render(<NewsletterConsentSwitch optedIn={false} loading={false} />);
    fireEvent.click(newsletterSwitch());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your newsletter choice was not saved. Try again.",
    );
    expect(newsletterSwitch()).not.toBeChecked();
    expect(newsletterSwitch()).toBeEnabled();
  });
});
