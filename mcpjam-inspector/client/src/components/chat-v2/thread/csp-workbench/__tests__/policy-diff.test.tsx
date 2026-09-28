// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PolicyDiffTab } from "../PolicyDiffTab";
import type { ClassifierInput } from "../types";

describe("PolicyDiffTab", () => {
  it("keeps browser policy evidence out of the user-facing diff", async () => {
    const input: ClassifierInput = {
      effective: {
        connectDomains: [],
        resourceDomains: [],
        frameDomains: ["https://js.stripe.com"],
        source: "applied",
      },
      appliedPoliciesByMount: {
        "1": {
          headerString: "default-src 'none'; frame-src https://js.stripe.com",
          mode: "widget-declared",
        },
        "2": {
          headerString: "default-src 'none'; frame-src https://js.stripe.com",
          mode: "widget-declared",
        },
      },
      widgetDeclared: { frameDomains: ["https://js.stripe.com"] },
      violations: [
        {
          directive: "frame-src",
          blockedUri: "https://js.stripe.com/a",
          mountId: 1,
          originalPolicy: "frame-src https://js.stripe.com; default-src 'none'",
          disposition: "enforce",
          timestamp: 1,
        },
        {
          directive: "frame-src",
          blockedUri: "https://js.stripe.com/b",
          mountId: 2,
          originalPolicy: "default-src 'none'; frame-src 'none'",
          disposition: "enforce",
          timestamp: 2,
        },
        {
          directive: "frame-src",
          blockedUri: "https://js.stripe.com/c",
          originalPolicy: "frame-src 'none'",
          disposition: "report",
          timestamp: 3,
        },
      ],
    };

    render(<PolicyDiffTab input={input} diagnoses={[]} />);

    expect(screen.getAllByText("Effective").length).toBeGreaterThan(0);
    expect(screen.getByText("by client")).toBeTruthy();
    await userEvent.hover(
      screen.getByLabelText("The CSP the client applied to this widget."),
    );
    expect(
      (await screen.findAllByText("The CSP the client applied to this widget."))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Effective is parsed from/)).toBeNull();
    expect(screen.queryByText("Violation policy evidence")).toBeNull();
    expect(screen.queryByText(/Browser-reported policy/)).toBeNull();
    expect(screen.queryByText("Client-applied policy")).toBeNull();
    expect(screen.queryByRole("link", { name: "originalPolicy" })).toBeNull();
  });
});
