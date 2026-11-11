import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RequestUpgradeButton,
  buildUpgradeRequestMail,
  buildUpgradeRequestMessage,
} from "../RequestUpgradeButton";

const { trackMock, copyToClipboardMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  copyToClipboardMock: vi.fn(),
}));
vi.mock("@/lib/analytics", () => ({ track: trackMock }));
vi.mock("@/lib/clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clipboard")>();
  copyToClipboardMock.mockImplementation(actual.copyToClipboard);
  return { copyToClipboard: copyToClipboardMock };
});

const OWNER = { email: "dana@acme.test", name: "Dana Ruiz" };

beforeEach(async () => {
  trackMock.mockReset();
  const actual =
    await vi.importActual<typeof import("@/lib/clipboard")>("@/lib/clipboard");
  copyToClipboardMock.mockReset();
  copyToClipboardMock.mockImplementation(actual.copyToClipboard);
});

describe("buildUpgradeRequestMail", () => {
  it("addresses every owner and spells out the steps they have to take", () => {
    const href = buildUpgradeRequestMail({
      recipients: [OWNER, { email: "sam@acme.test", name: null }],
      organizationName: "Acme Robotics",
      teamName: "Team",
      origin: "evals",
    });

    expect(href).not.toBeNull();
    const decoded = decodeURIComponent(href!);
    expect(decoded).toContain("mailto:dana@acme.test,sam@acme.test");
    expect(decoded).toContain(
      "Upgrade request: MCPJam Team plan for Acme Robotics",
    );
    expect(decoded).toContain("Hi Dana,");
    expect(decoded).toContain("hit the free plan's eval iteration limit");
    // The owner cannot act on a request that doesn't say what to do.
    expect(decoded).toContain(
      "1. Open MCPJam, go to Organizations, then Billing.",
    );
    expect(decoded).toContain(
      "2. Under the Team plan, pick Annual or Monthly.",
    );
    expect(decoded).toContain(
      "3. Click Upgrade and finish checkout with Stripe.",
    );
  });

  it("describes the credits wall differently from the eval wall", () => {
    const href = buildUpgradeRequestMail({
      recipients: [OWNER],
      organizationName: "Acme Robotics",
      teamName: "Team",
      origin: "credits",
    });

    expect(decodeURIComponent(href!)).toContain("run out of MCPJam credits");
  });

  it("asks a paid organization to buy credits instead of upgrading", () => {
    const href = buildUpgradeRequestMail({
      recipients: [OWNER],
      organizationName: "Acme Robotics",
      teamName: "Team",
      origin: "credits",
      requestAction: "buyCredits",
    });

    const decoded = decodeURIComponent(href!);
    expect(decoded).toContain("Credit purchase request for Acme Robotics");
    expect(decoded).toContain(
      "Our organization has run out of MCPJam credits.",
    );
    expect(decoded).toContain(
      "Could you buy more shared credits for Acme Robotics so we can continue testing before our included allowance renews?",
    );
    expect(decoded).toContain("2. Under Credits, click Buy credits.");
    expect(decoded).not.toContain("upgrade Acme Robotics to the Team plan");
  });

  it("percent-encodes an address so a reserved character can't truncate it", () => {
    const href = buildUpgradeRequestMail({
      recipients: [{ email: "dana#ops@acme.test", name: "Dana Ruiz" }],
      organizationName: "Acme Robotics",
      teamName: "Team",
      origin: "evals",
    });

    // Raw, the `#` would start the URL fragment: the recipient becomes
    // "dana" and the subject and body vanish. `@` stays literal — RFC 6068
    // encodes within the addr-spec, not the separator between its parts.
    expect(href).toContain("mailto:dana%23ops@acme.test?subject=");
    expect(decodeURIComponent(href!)).toContain("mailto:dana#ops@acme.test");
  });

  it("returns null when there is nobody to address", () => {
    expect(
      buildUpgradeRequestMail({
        recipients: [],
        organizationName: "Acme Robotics",
        teamName: "Team",
        origin: "evals",
      }),
    ).toBeNull();
  });
});

describe("RequestUpgradeButton", () => {
  it("renders a mailto anchor naming the recipient", () => {
    render(
      <RequestUpgradeButton
        recipients={[OWNER]}
        organizationName="Acme Robotics"
        teamName="Team"
        origin="evals"
        limitKind="evalIterations"
      />,
    );

    const href = screen
      .getByTestId("request-upgrade-mail")
      .getAttribute("href");
    expect(decodeURIComponent(href!)).toContain("mailto:dana@acme.test");
    // Plain text above the buttons, not a gray caption under the email button
    // that reads like a link and drew dead clicks (PLB-176).
    expect(screen.getByTestId("request-upgrade-owners")).toHaveTextContent(
      "Send the request to Dana Ruiz (owner) by email, or copy it for Slack or anywhere else.",
    );
    expect(
      screen.getByTestId("request-upgrade-owners").tagName.toLowerCase(),
    ).toBe("p");
    expect(screen.queryByText(/Opens a draft/)).not.toBeInTheDocument();
  });

  it("counts the other owners when there are several", () => {
    render(
      <RequestUpgradeButton
        recipients={[OWNER, { email: "sam@acme.test" }]}
        organizationName="Acme Robotics"
        teamName="Team"
        origin="evals"
        limitKind="evalIterations"
      />,
    );

    expect(screen.getByTestId("request-upgrade-owners")).toHaveTextContent(
      /Send the request to Dana Ruiz and 1 other owner by email/,
    );
  });

  it("falls back to the owner's address when there is no name", () => {
    render(
      <RequestUpgradeButton
        recipients={[{ email: "sam@acme.test", name: null }]}
        organizationName="Acme Robotics"
        teamName="Team"
        origin="credits"
        limitKind="credits"
      />,
    );

    expect(screen.getByTestId("request-upgrade-owners")).toHaveTextContent(
      /Send the request to sam@acme.test \(owner\) by email/,
    );
  });

  it("copies the same request the email carries, for Slack or browser Gmail", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    render(
      <RequestUpgradeButton
        recipients={[OWNER]}
        organizationName="Acme Robotics"
        teamName="Team"
        origin="credits"
        limitKind="credits"
        requestAction="buyCredits"
      />,
    );

    await user.click(screen.getByTestId("request-upgrade-copy"));

    const copied = writeText.mock.calls[0]?.[0] ?? "";
    const { subject, body } = buildUpgradeRequestMessage({
      recipients: [OWNER],
      organizationName: "Acme Robotics",
      teamName: "Team",
      origin: "credits",
      requestAction: "buyCredits",
    });
    expect(copied).toBe(`${subject}\n\n${body}`);
    expect(copied).toContain("Credit purchase request for Acme Robotics");
    expect(copied).toContain("2. Under Credits, click Buy credits.");
    expect(screen.getByTestId("request-upgrade-copy")).toHaveTextContent(
      "Copied",
    );
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_upgrade_requested",
      expect.objectContaining({
        outcome: "request_copied",
        copy_succeeded: true,
        request_action: "buyCredits",
      }),
    );
  });

  it("says so when the copy fails instead of claiming it worked", async () => {
    const user = userEvent.setup();
    copyToClipboardMock.mockResolvedValueOnce(false);
    render(
      <RequestUpgradeButton
        recipients={[OWNER]}
        organizationName="Acme Robotics"
        teamName="Team"
        origin="evals"
        limitKind="evalIterations"
      />,
    );

    await user.click(screen.getByTestId("request-upgrade-copy"));

    expect(screen.getByTestId("request-upgrade-copy")).toHaveTextContent(
      "Couldn't copy",
    );
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_upgrade_requested",
      expect.objectContaining({
        outcome: "request_copied",
        copy_succeeded: false,
      }),
    );
  });

  it("renders nothing rather than a button that opens an empty draft", () => {
    const { container } = render(
      <RequestUpgradeButton
        recipients={[]}
        organizationName="Acme Robotics"
        teamName="Team"
        origin="evals"
        limitKind="evalIterations"
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("reports the request", async () => {
    const user = userEvent.setup();
    render(
      <RequestUpgradeButton
        recipients={[OWNER]}
        organizationName="Acme Robotics"
        teamName="Team"
        origin="evals"
        limitKind="evalIterations"
      />,
    );

    await user.click(screen.getByTestId("request-upgrade-mail"));
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_upgrade_requested",
      expect.objectContaining({ origin: "evals", recipient_count: 1 }),
    );
  });
});
