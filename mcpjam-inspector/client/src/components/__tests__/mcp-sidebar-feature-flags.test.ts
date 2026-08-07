import { describe, it, expect } from "vitest";
import {
  applyBillingGateNavState,
  filterByFeatureFlags,
  getHostedNavigationSections,
  navigationSections,
} from "../mcp-sidebar";

const FakeIcon = () => null;

const makeSections = () => [
  {
    id: "main",
    items: [
      { title: "Always Visible", url: "#always", icon: FakeIcon },
      {
        title: "Testing",
        url: "/evals",
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

  it("hides XAA Debugger when the xaa flag is off", () => {
    const result = filterByFeatureFlags(
      [
        {
          id: "others",
          items: [
            { title: "OAuth Debugger", url: "#oauth-flow", icon: FakeIcon },
            {
              title: "XAA Debugger",
              url: "#xaa-flow",
              icon: FakeIcon,
              featureFlag: "xaa",
            },
          ],
        },
      ],
      { xaa: false },
    );

    expect(result[0].items.map((i) => i.title)).toEqual(["OAuth Debugger"]);
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

  it("ships Evaluate as one flat, unflagged item (Runs is an in-page mode)", () => {
    // Runs used to be a nested subnav item gated by `evaluate-ci`. Both lenses
    // now live under one Evaluate entry and switch in the page header, so the
    // sidebar carries no eval sub-items and no eval flag.
    const evalsItems = navigationSections
      .flatMap((section) => section.items)
      .filter((item) => item.url.startsWith("/evals"));
    expect(evalsItems).toHaveLength(1);
    expect(evalsItems[0]).toMatchObject({
      title: "Evaluate",
      url: "/evals",
      billingFeature: "evals",
    });
    expect(evalsItems[0].featureFlag).toBeUndefined();
  });

  it("hides Conformance when the feature flag is off", () => {
    const result = filterByFeatureFlags(
      [
        {
          id: "others",
          items: [
            {
              title: "Conformance",
              url: "#conformance",
              icon: FakeIcon,
              featureFlag: "mcpjam-conformance",
            },
            {
              title: "OAuth Debugger",
              url: "#oauth-flow",
              icon: FakeIcon,
            },
          ],
        },
      ],
      { "mcpjam-conformance": false },
    );

    expect(result[0].items.map((item) => item.title)).toEqual([
      "OAuth Debugger",
    ]);
  });

  it("keeps Chatboxes behind the existing sandboxes flag", () => {
    const sections = [
      {
        id: "connection",
        items: [
          {
            title: "Chatboxes",
            url: "#chatboxes",
            icon: FakeIcon,
            featureFlag: "sandboxes-enabled",
            billingFeature: "chatboxes" as const,
          },
        ],
      },
    ];

    expect(
      filterByFeatureFlags(sections, { "sandboxes-enabled": true })[0].items,
    ).toEqual([
      {
        title: "Chatboxes",
        url: "#chatboxes",
        icon: FakeIcon,
        featureFlag: "sandboxes-enabled",
        billingFeature: "chatboxes",
      },
    ]);
    expect(
      filterByFeatureFlags(sections, { "sandboxes-enabled": false }),
    ).toHaveLength(0);
  });

  it("marks Chatboxes disabled when billing enforcement denies chatboxes", () => {
    const result = applyBillingGateNavState(
      [
        {
          id: "connection",
          items: [
            {
              title: "Chatboxes",
              url: "/chatboxes",
              icon: FakeIcon,
              billingFeature: "chatboxes",
            },
          ],
        },
      ],
      {
        billingUiEnabled: true,
        gateDenied: { chatboxes: true },
        enforcementActive: true,
      },
    );

    expect(result[0].items[0].disabled).toBe(true);
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
              url: "/evals",
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
              url: "/evals",
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
  it("drops hosted-blocked tabs and keeps hosted-capable ones", () => {
    const result = getHostedNavigationSections([
      {
        id: "others",
        items: [
          // Skills is deliberately NOT sidebar-allowed in hosted mode — it is
          // reached through the Servers tab switcher — so it is dropped here.
          { title: "Skills", url: "#skills", icon: FakeIcon },
          { title: "Tasks", url: "#tasks", icon: FakeIcon },
          {
            title: "Testing",
            url: "/evals",
            icon: FakeIcon,
            billingFeature: "evals",
          },
          {
            title: "Conformance",
            url: "#conformance",
            icon: FakeIcon,
            featureFlag: "mcpjam-conformance",
          },
          { title: "OAuth Debugger", url: "#oauth-flow", icon: FakeIcon },
          { title: "XAA Debugger", url: "#xaa-flow", icon: FakeIcon },
        ],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].items).toEqual([
      // Tasks are hosted-capable (reconnect-per-poll routes), so the item stays.
      { title: "Tasks", url: "#tasks", icon: FakeIcon },
      {
        title: "Testing",
        url: "/evals",
        icon: FakeIcon,
        billingFeature: "evals",
      },
      {
        title: "Conformance",
        url: "#conformance",
        icon: FakeIcon,
        featureFlag: "mcpjam-conformance",
      },
      {
        title: "OAuth Debugger",
        url: "#oauth-flow",
        icon: FakeIcon,
      },
      {
        title: "XAA Debugger",
        url: "#xaa-flow",
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
            url: "/evals",
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

  it("keeps the Evaluate entry in hosted mode", () => {
    const hostedSections = getHostedNavigationSections([
      {
        id: "mcp-apps",
        items: [
          {
            title: "Evaluate",
            url: "#evals",
            icon: FakeIcon,
            billingFeature: "evals",
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
      },
    ]);
  });
});

describe("Skills is no longer a sidebar item", () => {
  // Skills moved into Connect as a fourth tab (Servers | Client | Computer |
  // Skills); the sidebar has no Skills entry in either mode, and the hosted
  // filter must not resurrect one.
  it("has no /skills item in any section, local or hosted", () => {
    const skillsItems = (sections: typeof navigationSections) =>
      sections.flatMap((section) =>
        section.items.filter(
          (item) => item.url.replace(/^[#/]+/, "") === "skills"
        )
      );

    const hosted = getHostedNavigationSections(navigationSections);
    expect(skillsItems(navigationSections)).toEqual([]);
    expect(skillsItems(hosted)).toEqual([]);
  });
});

// The sidebar uses `featureFlag` to keep the current "Servers" item visible
// and `hiddenByFlag` to swap the legacy "Servers" item out. The
// "hosts-enabled" map entry is auth-driven (the PostHog rollout finished and
// the flag was removed): signed-in users get the current item, signed-out
// users keep the legacy one. Both are titled "Servers" in production (the
// item used to be titled "Connect" until PUR-1 renamed it); the fixture below
// gives them distinct titles purely so assertions here can tell which one
// survived the filter.
describe("filterByFeatureFlags (Servers current/legacy swap)", () => {
  const currentAndLegacyServers = () => [
    {
      id: "connection",
      items: [
        {
          title: "Servers (current)",
          url: "/servers",
          icon: FakeIcon,
          featureFlag: "hosts-enabled",
        },
        {
          title: "Servers (legacy)",
          url: "/servers",
          icon: FakeIcon,
          hiddenByFlag: "hosts-enabled",
        },
      ],
    },
  ];

  it("shows the current Servers item (and hides the legacy one) when authenticated", () => {
    const result = filterByFeatureFlags(currentAndLegacyServers(), {
      "hosts-enabled": true,
    });
    expect(result[0].items.map((i) => i.title)).toEqual(["Servers (current)"]);
  });

  it("falls back to the legacy Servers item until the user signs in", () => {
    const result = filterByFeatureFlags(currentAndLegacyServers(), {
      "hosts-enabled": false,
    });
    expect(result[0].items.map((i) => i.title)).toEqual(["Servers (legacy)"]);
  });

  it("real navigationSections: exactly one 'Servers' item is visible per flag state, never both", () => {
    const authed = filterByFeatureFlags(navigationSections, {
      "hosts-enabled": true,
    });
    const signedOut = filterByFeatureFlags(navigationSections, {
      "hosts-enabled": false,
    });

    const serversTitles = (sections: typeof navigationSections) =>
      sections
        .flatMap((s) => s.items)
        .filter((i) => i.url.replace(/^[#/]+/, "") === "servers")
        .map((i) => i.title);

    expect(serversTitles(authed)).toEqual(["Servers"]);
    expect(serversTitles(signedOut)).toEqual(["Servers"]);
  });
});
