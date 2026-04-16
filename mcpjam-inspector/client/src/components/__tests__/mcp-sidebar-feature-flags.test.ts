import { describe, it, expect } from "vitest";
import {
  applyBillingGateNavState,
  filterByFeatureFlags,
  getEvalsSubnavItems,
  getHostedNavigationSections,
  shouldPrefetchSidebarTools,
} from "../mcp-sidebar";
import { HOSTED_LOCAL_ONLY_TOOLTIP } from "@/lib/hosted-ui";

const FakeIcon = () => null;

const makeSections = () => [
  {
    id: "main",
    items: [
      { title: "Always Visible", url: "#always", icon: FakeIcon },
      {
        title: "Testing",
        url: "#ci-evals",
        icon: FakeIcon,
      },
    ],
  },
];

describe("filterByFeatureFlags", () => {
  it("treats a missing flag as disabled", () => {
    const result = filterByFeatureFlags(makeSections(), {});
    const titles = result[0].items.map((i) => i.title);
    expect(titles).toContain("Always Visible");
    expect(titles).toContain("Testing");
  });

  it("hides featureFlag items when flag is off", () => {
    const result = filterByFeatureFlags(
      [
        {
          id: "main",
          items: [
            { title: "Always Visible", url: "#always", icon: FakeIcon },
            {
              title: "Registry",
              url: "#registry",
              icon: FakeIcon,
              featureFlag: "registry-enabled",
            },
          ],
        },
      ],
      { "registry-enabled": false },
    );
    const titles = result[0].items.map((i) => i.title);
    expect(titles).toEqual(["Always Visible"]);
  });

  it("keeps Testing visible when unrelated flags are on", () => {
    const result = filterByFeatureFlags(makeSections(), {
      "registry-enabled": true,
    });
    const titles = result[0].items.map((i) => i.title);
    expect(titles).toContain("Always Visible");
    expect(titles).toContain("Testing");
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

  it("keeps Evaluate item visible when evaluate-runs is off", () => {
    const result = filterByFeatureFlags(
      [
        {
          id: "mcp-apps",
          items: [
            { title: "App Builder", url: "#app-builder", icon: FakeIcon },
            {
              title: "Evaluate",
              url: "#evals",
              icon: FakeIcon,
              billingFeature: "evals" as const,
              evalsSubnav: true,
            },
          ],
        },
      ],
      { "evaluate-runs": false },
    );
    const titles = result[0].items.map((i) => i.title);
    expect(titles).toEqual(["App Builder", "Evaluate"]);
  });

  it("keeps Playground visible when evaluate-runs is off", () => {
    expect(
      getEvalsSubnavItems({ evaluateRunsEnabled: false }).map(
        (item) => item.title,
      ),
    ).toEqual(["Playground"]);
  });

  it("shows Runs when evaluate-runs is on", () => {
    expect(
      getEvalsSubnavItems({ evaluateRunsEnabled: true }).map(
        (item) => item.title,
      ),
    ).toEqual(["Playground", "Runs"]);
  });
});

describe("applyBillingGateNavState", () => {
  it("keeps billed items enabled when enforcement is inactive", () => {
    const result = applyBillingGateNavState(
      [
        {
          id: "main",
          items: [
            {
              title: "Testing",
              url: "#ci-evals",
              icon: FakeIcon,
              billingFeature: "evals",
            },
          ],
        },
      ],
      {
        billingUiEnabled: true,
        gateDenied: { evals: true },
        enforcementActive: false,
      },
    );

    expect(result[0].items[0].disabled).not.toBe(true);
  });

  it("marks billed items disabled when enforcement is active and the gate denies access", () => {
    const result = applyBillingGateNavState(
      [
        {
          id: "main",
          items: [
            {
              title: "Testing",
              url: "#ci-evals",
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
      {
        billingUiEnabled: true,
        gateDenied: { evals: true },
        enforcementActive: true,
      },
    );

    const evalItem = result[0].items.find((i) => i.title === "Testing");
    const servers = result[0].items.find((i) => i.title === "Servers");
    expect(evalItem?.disabled).toBe(true);
    expect(servers?.disabled).not.toBe(true);
  });
});

describe("getHostedNavigationSections", () => {
  it("keeps hosted-blocked local tabs visible as disabled hosted-only items", () => {
    const result = getHostedNavigationSections([
      {
        id: "others",
        items: [
          { title: "Skills", url: "#skills", icon: FakeIcon },
          { title: "Tasks", url: "#tasks", icon: FakeIcon },
          {
            title: "Testing",
            url: "#ci-evals",
            icon: FakeIcon,
            billingFeature: "evals",
          },
          { title: "Conformance", url: "#conformance", icon: FakeIcon },
          { title: "OAuth Debugger", url: "#oauth-flow", icon: FakeIcon },
        ],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].items).toEqual([
      {
        title: "Skills",
        url: "#skills",
        icon: FakeIcon,
        disabled: true,
        disabledTooltip: HOSTED_LOCAL_ONLY_TOOLTIP,
      },
      {
        title: "Testing",
        url: "#ci-evals",
        icon: FakeIcon,
        billingFeature: "evals",
      },
      {
        title: "Conformance",
        url: "#conformance",
        icon: FakeIcon,
      },
      {
        title: "OAuth Debugger",
        url: "#oauth-flow",
        icon: FakeIcon,
      },
    ]);
  });

  it("keeps Testing visible in hosted", () => {
    const hostedSections = getHostedNavigationSections([
      {
        id: "mcp-apps",
        items: [
          {
            title: "Testing",
            url: "#ci-evals",
            icon: FakeIcon,
          },
        ],
      },
    ]);

    const visibleSections = filterByFeatureFlags(hostedSections, {});

    expect(visibleSections[0].items.map((item) => item.title)).toEqual([
      "Testing",
    ]);
  });

  it("keeps Evaluate subnav entry with #evals in hosted mode", () => {
    const hostedSections = getHostedNavigationSections([
      {
        id: "mcp-apps",
        items: [
          {
            title: "Evaluate",
            url: "#evals",
            icon: FakeIcon,
            billingFeature: "evals",
            evalsSubnav: true,
          },
        ],
      },
    ]);

    expect(hostedSections[0].items).toEqual([
      {
        title: "Evaluate",
        url: "#evals",
        icon: FakeIcon,
        billingFeature: "evals",
        evalsSubnav: true,
      },
    ]);
  });
});

describe("shouldPrefetchSidebarTools", () => {
  it("skips sidebar tool prefetch for hosted guests", () => {
    expect(
      shouldPrefetchSidebarTools({
        hostedMode: true,
        isAuthenticated: false,
      }),
    ).toBe(false);
  });

  it("allows sidebar tool prefetch for hosted signed-in users", () => {
    expect(
      shouldPrefetchSidebarTools({
        hostedMode: true,
        isAuthenticated: true,
      }),
    ).toBe(true);
  });

  it("allows sidebar tool prefetch outside hosted mode", () => {
    expect(
      shouldPrefetchSidebarTools({
        hostedMode: false,
        isAuthenticated: false,
      }),
    ).toBe(true);
  });
});
