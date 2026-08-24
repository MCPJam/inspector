import { describe, it, expect } from "vitest";
import {
  applyBillingGateNavState,
  filterByFeatureFlags,
  getHostedNavigationSections,
  navigationSections,
  SIDEBAR_RESOLVED_FLAG_KEYS,
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
      { "registry-enabled": false }
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
      { xaa: false }
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
      { "mcpjam-conformance": false }
    );

    expect(result[0].items.map((item) => item.title)).toEqual([
      "OAuth Debugger",
    ]);
  });

  it("keeps Scenarios behind the existing sandboxes flag", () => {
    const sections = [
      {
        id: "connection",
        items: [
          {
            title: "Scenarios",
            url: "#scenarios",
            icon: FakeIcon,
            featureFlag: "sandboxes-enabled",
            billingFeature: "scenarios" as const,
          },
        ],
      },
    ];

    expect(
      filterByFeatureFlags(sections, { "sandboxes-enabled": true })[0].items
    ).toEqual([
      {
        title: "Scenarios",
        url: "#scenarios",
        icon: FakeIcon,
        featureFlag: "sandboxes-enabled",
        billingFeature: "scenarios",
      },
    ]);
    expect(
      filterByFeatureFlags(sections, { "sandboxes-enabled": false })
    ).toHaveLength(0);
  });

  it("marks Scenarios disabled when billing enforcement denies scenarios", () => {
    const result = applyBillingGateNavState(
      [
        {
          id: "connection",
          items: [
            {
              title: "Scenarios",
              url: "/scenarios",
              icon: FakeIcon,
              billingFeature: "scenarios",
            },
          ],
        },
      ],
      {
        billingUiEnabled: true,
        gateDenied: { scenarios: true },
        enforcementActive: true,
      }
    );

    expect(result[0].items[0].disabled).toBe(true);
  });
});

describe("declared nav flags are actually resolved", () => {
  // The bug this guards: a nav item can declare `featureFlag: "x"` while the
  // sidebar's `featureFlags` map never sets `x`. `filterByFeatureFlags` then
  // reads `undefined`, hides the item permanently, and — because nothing ever
  // calls the flag — PostHog reports it as never evaluated, which reads like a
  // rollout/targeting problem instead of a missing map entry. Sessions shipped
  // that way and was invisible in production with a correctly-configured flag.
  it("every featureFlag / hiddenByFlag key in navigationSections is in SIDEBAR_RESOLVED_FLAG_KEYS", () => {
    const declared = new Set<string>();
    for (const section of navigationSections) {
      for (const item of section.items) {
        if (item.featureFlag) declared.add(item.featureFlag);
        if (item.hiddenByFlag) declared.add(item.hiddenByFlag);
      }
    }

    const resolved = new Set<string>(SIDEBAR_RESOLVED_FLAG_KEYS);
    const missing = [...declared].filter((key) => !resolved.has(key)).sort();

    expect(missing).toEqual([]);
  });

  it("Sessions is gated by unified-sessions-enabled and appears when it is on", () => {
    const sessionsItem = navigationSections
      .flatMap((section) => section.items)
      .find((item) => item.url === "/sessions");

    expect(sessionsItem).toMatchObject({
      title: "Sessions",
      featureFlag: "unified-sessions-enabled",
    });

    const off = filterByFeatureFlags(navigationSections, {})
      .flatMap((s) => s.items)
      .map((i) => i.title);
    expect(off).not.toContain("Sessions");

    const on = filterByFeatureFlags(navigationSections, {
      "unified-sessions-enabled": true,
    })
      .flatMap((s) => s.items)
      .map((i) => i.title);
    expect(on).toContain("Sessions");
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
      }
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
      }
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
          // Tracing is the one surface hosted cannot serve (it needs the
          // local OTLP collector), so it is the one item dropped here.
          { title: "Tracing", url: "#tracing", icon: FakeIcon },
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
      // Everything else survives: the filter is a block list now, so a tab
      // nobody thought to list is reachable rather than silently missing.
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

// The sidebar uses `featureFlag` to keep "Connect" visible and `hiddenByFlag`
// to swap "Servers" out. The "hosts-enabled" map entry is auth-driven (the
// PostHog rollout finished and the flag was removed): signed-in users get
// Connect, signed-out users keep the legacy Servers item.
describe("filterByFeatureFlags (Connect/Servers swap)", () => {
  const connectAndServers = () => [
    {
      id: "connection",
      items: [
        {
          title: "Connect",
          url: "/servers",
          icon: FakeIcon,
          featureFlag: "hosts-enabled",
        },
        {
          title: "Servers",
          url: "/servers",
          icon: FakeIcon,
          hiddenByFlag: "hosts-enabled",
        },
      ],
    },
  ];

  it("shows Connect (and hides legacy Servers) when authenticated", () => {
    const result = filterByFeatureFlags(connectAndServers(), {
      "hosts-enabled": true,
    });
    expect(result[0].items.map((i) => i.title)).toEqual(["Connect"]);
  });

  it("falls back to legacy Servers until the user signs in", () => {
    const result = filterByFeatureFlags(connectAndServers(), {
      "hosts-enabled": false,
    });
    expect(result[0].items.map((i) => i.title)).toEqual(["Servers"]);
  });

  it("real navigationSections: exactly one /servers item is visible per flag state, never both", () => {
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

    expect(serversTitles(authed)).toEqual(["Connect"]);
    expect(serversTitles(signedOut)).toEqual(["Servers"]);
  });
});
