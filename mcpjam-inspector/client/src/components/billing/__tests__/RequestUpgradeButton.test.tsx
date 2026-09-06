import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RequestUpgradeButton,
  buildUpgradeRequestMail,
} from "../RequestUpgradeButton";

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: trackMock }));

const OWNER = { email: "dana@acme.test", name: "Dana Ruiz" };

beforeEach(() => {
  trackMock.mockReset();
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
      "Upgrade request: MCPJam Team plan for Acme Robotics"
    );
    expect(decoded).toContain("Hi Dana,");
    expect(decoded).toContain("hit the free plan's eval iteration limit");
    // The owner cannot act on a request that doesn't say what to do.
    expect(decoded).toContain("1. Open MCPJam, go to Organizations, then Billing.");
    expect(decoded).toContain("2. Under the Team plan, pick Annual or Monthly.");
    expect(decoded).toContain("3. Click Upgrade and finish checkout with Stripe.");
  });

  it("describes the credits wall differently from the eval wall", () => {
    const href = buildUpgradeRequestMail({
      recipients: [OWNER],
      organizationName: "Acme Robotics",
      teamName: "Team",
      origin: "credits",
    });

    expect(decodeURIComponent(href!)).toContain("run out of credits");
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
      "Our organization has run out of MCPJam credits."
    );
    expect(decoded).toContain(
      "Could you buy more credits for Acme Robotics?"
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
      })
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
      />
    );

    const href = screen
      .getByTestId("request-upgrade-mail")
      .getAttribute("href");
    expect(decodeURIComponent(href!)).toContain("mailto:dana@acme.test");
    expect(screen.getByText(/Opens a draft to Dana Ruiz/)).toBeInTheDocument();
  });

  it("counts the other owners when there are several", () => {
    render(
      <RequestUpgradeButton
        recipients={[OWNER, { email: "sam@acme.test" }]}
        organizationName="Acme Robotics"
        teamName="Team"
        origin="evals"
        limitKind="evalIterations"
      />
    );

    expect(
      screen.getByText(/Opens a draft to Dana Ruiz and 1 other owner/)
    ).toBeInTheDocument();
  });

  it("renders nothing rather than a button that opens an empty draft", () => {
    const { container } = render(
      <RequestUpgradeButton
        recipients={[]}
        organizationName="Acme Robotics"
        teamName="Team"
        origin="evals"
        limitKind="evalIterations"
      />
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
      />
    );

    await user.click(screen.getByTestId("request-upgrade-mail"));
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_upgrade_requested",
      expect.objectContaining({ origin: "evals", recipient_count: 1 })
    );
  });
});
