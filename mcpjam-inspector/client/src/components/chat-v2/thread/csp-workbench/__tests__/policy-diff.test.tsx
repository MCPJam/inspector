// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PolicyDiffTab } from "../PolicyDiffTab";
import type { ClassifierInput } from "../types";

describe("PolicyDiffTab violation evidence", () => {
  it("shows matching, different, and unavailable policy comparisons", () => {
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
          timestamp: 3,
        },
      ],
    };

    render(<PolicyDiffTab input={input} diagnoses={[]} />);

    expect(screen.getAllByText("Applied").length).toBeGreaterThan(0);
    expect(screen.getByText("Matches Applied")).toBeTruthy();
    expect(screen.getByText("Differs from Applied")).toBeTruthy();
    expect(screen.getByText("Comparison unavailable")).toBeTruthy();
    expect(screen.getByText(/mount unknown/)).toBeTruthy();
  });
});
