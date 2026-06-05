import { describe, it, expect } from "vitest";
import {
  applyBillingGateNavState,
  computeHostsHubFlagEnabled,
  filterByFeatureFlags,
  getEvalsSubnavItems,
  getHostedNavigationSections,
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

  it("keeps Evaluate item visible when evaluate-ci is off", () => {
    const result = filterByFeatureFlags(
      [
        {
          id: "mcp-apps",
          items: [
            { title: "Views", url: "#views", icon: FakeIcon },
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
      { "evaluate-ci": false },
    );
    const titles = result[0].items.map((i) => i.title);
    expect(titles).toEqual(["Views", "Evaluate"]);
  });

  it("renders no subnav when evaluate-ci is off (Evaluate is a flat link)", () => {
    expect(
      getEvalsSubnavItems({ evaluateRunsEnabled: false }).map(
        (item) => item.title,
      ),
    ).toEqual([]);
  });

  it("shows Runs as the only subnav item when evaluate-ci is on", () => {
    expect(
      getEvalsSubnavItems({ evaluateRunsEnabled: true }).map(
        (item) => item.title,
      ),
    ).toEqual(["Runs"]);
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

// The packaged Electron app ships a single binary with no staged rollout, so
// gating Hosts/Connect on PostHog would just hide the new UI whenever the
// feature flag hasn't resolved (or is blocked entirely). Desktop must default
// the flag on for signed-in users while hosted web keeps the PostHog gate.
//
// Regression: Ray reported the desktop Clients tab showed empty/no affordances
// because `useFeatureFlagEnabled("hosts-enabled")` returned `undefined` in the
// packaged app, which collapsed both the sidebar nav filter and `ClientsRoute`
// gate to `false`. See `computeHostsHubFlagEnabled` in `mcp-sidebar.tsx`.
describe("computeHostsHubFlagEnabled", () => {
  it("defaults on for desktop when PostHog has not resolved the flag", () => {
    expect(
      computeHostsHubFlagEnabled({
        hostsFlag: undefined,
        hostedMode: false,
      }),
    ).toBe(true);
  });

  it("defaults on for desktop even when PostHog reports the flag off", () => {
    expect(
      computeHostsHubFlagEnabled({
        hostsFlag: false,
        hostedMode: false,
      }),
    ).toBe(true);
  });

  it("honors the PostHog flag in hosted web when the flag is on", () => {
    expect(
      computeHostsHubFlagEnabled({ hostsFlag: true, hostedMode: true }),
    ).toBe(true);
  });

  it("keeps Hosts/Connect hidden in hosted web until PostHog enables it", () => {
    expect(
      computeHostsHubFlagEnabled({ hostsFlag: undefined, hostedMode: true }),
    ).toBe(false);
    expect(
      computeHostsHubFlagEnabled({ hostsFlag: false, hostedMode: true }),
    ).toBe(false);
  });
});

// The sidebar uses `featureFlag` to keep "Connect" visible and `hiddenByFlag`
// to swap "Servers" out once the rollout fires. Wire the helper through the
// nav filter the same way the component does and verify the desktop default-on
// path keeps "Connect" visible (and hides legacy "Servers") even when PostHog
// has not resolved the flag.
describe("filterByFeatureFlags + computeHostsHubFlagEnabled (Connect/Servers swap)", () => {
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

  const hostsEnabledForNav = (
    hostsFlag: unknown,
    hostedMode: boolean,
    isAuthenticated: boolean,
  ) =>
    computeHostsHubFlagEnabled({ hostsFlag, hostedMode }) && isAuthenticated;

  it("shows Connect on desktop when authenticated and PostHog is silent", () => {
    const result = filterByFeatureFlags(connectAndServers(), {
      "hosts-enabled": hostsEnabledForNav(undefined, false, true),
    });
    expect(result[0].items.map((i) => i.title)).toEqual(["Connect"]);
  });

  it("shows Connect on desktop when authenticated and PostHog reports off", () => {
    const result = filterByFeatureFlags(connectAndServers(), {
      "hosts-enabled": hostsEnabledForNav(false, false, true),
    });
    expect(result[0].items.map((i) => i.title)).toEqual(["Connect"]);
  });

  it("falls back to legacy Servers on desktop until the user signs in", () => {
    const result = filterByFeatureFlags(connectAndServers(), {
      "hosts-enabled": hostsEnabledForNav(undefined, false, false),
    });
    expect(result[0].items.map((i) => i.title)).toEqual(["Servers"]);
  });

  it("keeps legacy Servers on hosted web until PostHog enables the rollout", () => {
    const result = filterByFeatureFlags(connectAndServers(), {
      "hosts-enabled": hostsEnabledForNav(undefined, true, true),
    });
    expect(result[0].items.map((i) => i.title)).toEqual(["Servers"]);
  });

  it("swaps to Connect on hosted web once PostHog enables the rollout", () => {
    const result = filterByFeatureFlags(connectAndServers(), {
      "hosts-enabled": hostsEnabledForNav(true, true, true),
    });
    expect(result[0].items.map((i) => i.title)).toEqual(["Connect"]);
  });
});
