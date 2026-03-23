import { describe, it, expect } from "vitest";
import {
  filterByBillingEntitlements,
  filterByFeatureFlags,
} from "../mcp-sidebar";

const FakeIcon = () => null;

const makeSections = () => [
  {
    id: "main",
    items: [
      { title: "Always Visible", url: "#always", icon: FakeIcon },
      {
        title: "Generate Evals",
        url: "#evals",
        icon: FakeIcon,
        hiddenByFlag: "ci-evals-enabled",
      },
      {
        title: "Evals CI/CD",
        url: "#ci-evals",
        icon: FakeIcon,
        featureFlag: "ci-evals-enabled",
      },
    ],
  },
];

describe("filterByFeatureFlags", () => {
  it("treats a missing flag as disabled", () => {
    const result = filterByFeatureFlags(makeSections(), {});
    const titles = result[0].items.map((i) => i.title);
    expect(titles).toContain("Always Visible");
    expect(titles).toContain("Generate Evals");
    expect(titles).not.toContain("Evals CI/CD");
  });

  it("hides featureFlag items when flag is off", () => {
    const result = filterByFeatureFlags(makeSections(), {
      "ci-evals-enabled": false,
    });
    const titles = result[0].items.map((i) => i.title);
    expect(titles).toContain("Always Visible");
    expect(titles).toContain("Generate Evals");
    expect(titles).not.toContain("Evals CI/CD");
  });

  it("shows featureFlag items and hides hiddenByFlag items when flag is on", () => {
    const result = filterByFeatureFlags(makeSections(), {
      "ci-evals-enabled": true,
    });
    const titles = result[0].items.map((i) => i.title);
    expect(titles).toContain("Always Visible");
    expect(titles).not.toContain("Generate Evals");
    expect(titles).toContain("Evals CI/CD");
  });

  it("removes empty sections", () => {
    const sections = [
      {
        id: "flagged-only",
        items: [
          {
            title: "Gated",
            url: "#gated",
            icon: FakeIcon,
            featureFlag: "some-flag",
          },
        ],
      },
    ];
    const result = filterByFeatureFlags(sections, { "some-flag": false });
    expect(result).toHaveLength(0);
  });

  it("passes through items with no flag metadata", () => {
    const sections = [
      {
        id: "plain",
        items: [{ title: "Plain", url: "#plain", icon: FakeIcon }],
      },
    ];
    const result = filterByFeatureFlags(sections, {});
    expect(result[0].items).toHaveLength(1);
    expect(result[0].items[0].title).toBe("Plain");
  });
});

describe("filterByBillingEntitlements", () => {
  it("keeps billed items visible before enforcement is active", () => {
    const result = filterByBillingEntitlements(
      [
        {
          id: "main",
          items: [
            {
              title: "Generate Evals",
              url: "#evals",
              icon: FakeIcon,
              billingFeature: "evals",
            },
          ],
        },
      ],
      { evals: false },
      false,
    );

    expect(result[0].items.map((item) => item.title)).toContain(
      "Generate Evals",
    );
  });

  it("hides billed items when enforcement is active and the org lacks access", () => {
    const result = filterByBillingEntitlements(
      [
        {
          id: "main",
          items: [
            {
              title: "Generate Evals",
              url: "#evals",
              icon: FakeIcon,
              billingFeature: "evals",
            },
            {
              title: "Servers",
              url: "#servers",
              icon: FakeIcon,
            },
          ],
        },
      ],
      { evals: false },
      true,
    );

    const titles = result[0].items.map((item) => item.title);
    expect(titles).toContain("Servers");
    expect(titles).not.toContain("Generate Evals");
  });
});
