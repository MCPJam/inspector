import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The policy toggle is gated on the `xaa` feature flag (same gate as the
// per-server XAA auth option) — without it a flag-off user could enable the
// policy and lose the UI needed to register the servers it breaks.
const { featureFlagMock } = vi.hoisted(() => ({
  featureFlagMock: vi.fn((flag: string) => flag === "xaa"),
}));
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
  useFeatureFlagEnabled: (flag: string) => featureFlagMock(flag),
}));
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import {
  readXaaEnterprisePolicy,
  XAA_ENTERPRISE_POLICY_EXTENSION,
} from "@mcpjam/sdk/browser";
import { ProtocolTab } from "../ProtocolTab";

function renderTab(draft: HostConfigInputV2) {
  let latest = draft;
  const onDraftChange = vi.fn(
    (updater: (prev: HostConfigInputV2) => HostConfigInputV2) => {
      latest = updater(latest);
    }
  );
  const utils = render(
    <ProtocolTab draft={draft} onDraftChange={onDraftChange} attention={[]} />
  );
  return { ...utils, onDraftChange, getDraft: () => latest };
}

describe("ProtocolTab — enterprise-managed authorization policy switch", () => {
  it("toggling on writes the policy under mcpProfile.extensions", () => {
    const { getDraft } = renderTab(emptyHostConfigInputV2());
    const toggle = screen.getByRole("switch", {
      name: /enterprise-managed authorization/i,
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    const state = readXaaEnterprisePolicy(getDraft().mcpProfile);
    expect(state).toEqual({ kind: "on", policy: { idp: "mcpjam" } });
  });

  it("toggling off removes the policy and collapses an otherwise-empty profile to undefined", () => {
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      extensions: { [XAA_ENTERPRISE_POLICY_EXTENSION]: { idp: "mcpjam" } },
    };
    const { getDraft } = renderTab(draft);
    const toggle = screen.getByRole("switch", {
      name: /enterprise-managed authorization/i,
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);
    // Absence is semantic: a pre-feature host must hash byte-identically.
    expect(getDraft().mcpProfile).toBeUndefined();
  });

  it("preserves sibling profile fields and extensions across a toggle round-trip", () => {
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      mcpProtocolVersion: "2026-07-28",
      extensions: { "other/ext": { keep: true } },
    };
    const { getDraft, rerender, onDraftChange } = renderTab(draft);
    const toggle = () =>
      screen.getByRole("switch", {
        name: /enterprise-managed authorization/i,
      });
    fireEvent.click(toggle()); // on
    // Re-render with the updated draft (the parent does this in production)
    // so the second click reads the post-toggle state.
    rerender(
      <ProtocolTab
        draft={getDraft()}
        onDraftChange={onDraftChange}
        attention={[]}
      />
    );
    fireEvent.click(toggle()); // off
    expect(getDraft().mcpProfile).toEqual({
      profileVersion: 1,
      mcpProtocolVersion: "2026-07-28",
      extensions: { "other/ext": { keep: true } },
    });
  });

  it("renders an invalid stored policy as off with a repair warning", () => {
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      extensions: { [XAA_ENTERPRISE_POLICY_EXTENSION]: { idp: "okta" } },
    };
    renderTab(draft);
    const toggle = screen.getByRole("switch", {
      name: /enterprise-managed authorization/i,
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByText(/stored policy value is unsupported/i)
    ).toBeInTheDocument();
  });

  it("surfaces mcpProfile.extensions in the JSON doc so the policy is visible", () => {
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      extensions: { [XAA_ENTERPRISE_POLICY_EXTENSION]: { idp: "mcpjam" } },
    };
    renderTab(draft);
    // The CodeMirror editor renders the serialized doc text; the policy key
    // must be present in the surfaced JSON.
    expect(
      document.body.textContent?.includes(XAA_ENTERPRISE_POLICY_EXTENSION)
    ).toBe(true);
  });

  it("hides the toggle when the xaa flag is off (no policy on the host)", () => {
    featureFlagMock.mockImplementation(() => false);
    try {
      renderTab(emptyHostConfigInputV2());
      expect(
        screen.queryByRole("switch", {
          name: /enterprise-managed authorization/i,
        })
      ).toBeNull();
    } finally {
      featureFlagMock.mockImplementation((flag: string) => flag === "xaa");
    }
  });

  it("still shows the toggle with the flag off when a policy is already stored (never strand a host)", () => {
    featureFlagMock.mockImplementation(() => false);
    try {
      const draft = emptyHostConfigInputV2();
      draft.mcpProfile = {
        profileVersion: 1,
        extensions: { [XAA_ENTERPRISE_POLICY_EXTENSION]: { idp: "mcpjam" } },
      };
      renderTab(draft);
      expect(
        screen.getByRole("switch", {
          name: /enterprise-managed authorization/i,
        })
      ).toHaveAttribute("aria-checked", "true");
    } finally {
      featureFlagMock.mockImplementation((flag: string) => flag === "xaa");
    }
  });
});
