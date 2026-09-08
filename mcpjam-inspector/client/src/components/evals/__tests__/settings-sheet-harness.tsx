import { fireEvent, render } from "@testing-library/react";
import { vi } from "vitest";
import {
  createMemoryRouter,
  RouterProvider,
} from "react-router";
import { SuiteIterationsView } from "../suite-iterations-view";
import type { EvalSuite } from "../types";
import {
  VISIBLE_SUITE_SETTINGS_GROUPS,
  NESTED_SETTING_KEYS,
  SUITE_SETTINGS_HEADER_KEYS,
  type SuiteSettingsGroupId,
} from "../suite-settings-groups";
import {
  getSubsectionsForGroup,
  subsectionForSettingKey,
} from "../suite-settings-subsections";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";

/**
 * Rendering the settings sheet, once, for every test that needs it.
 *
 * The DATA ROUTER is the reason this exists rather than each test calling
 * `render` itself. The sheet holds unsaved settings, and the guard that stops
 * a navigation from discarding them uses React Router's `useBlocker`, which
 * only works inside a data router — the app is one (`client/src/router.tsx`),
 * and a test that renders the sheet bare gets an exception rather than a
 * result. Wrapping in one place keeps every settings test honest about the
 * environment the component actually runs in.
 */

export const noopNav = {
  toSuiteOverview: vi.fn(),
  toRunDetail: vi.fn(),
  toTestDetail: vi.fn(),
  toTestEdit: vi.fn(),
  toSuiteEdit: vi.fn(),
};

export const baseSuite: EvalSuite = {
  _id: "suite-1",
  createdBy: "u",
  name: "Test Suite",
  description: "",
  configRevision: "r",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
};

/**
 * The same suite on verdict policy v2.
 *
 * A SECOND suite rather than a flag, because the two policies are alternatives
 * and the sheet renders one set of rows or the other. A settings test that only
 * ever renders the legacy shape would let the v2 rows rot unnoticed — and the
 * manifest ratchet, which insists every declared row still exists, would fail
 * on rows that are perfectly fine but simply never rendered.
 */
export const v2Suite: EvalSuite = {
  ...baseSuite,
  verdictPolicyVersion: 2,
  verdictPolicyDefaults: { repetitions: 3, passThreshold: 0.8 },
};

/**
 * A suite whose configuration lives in a repository.
 *
 * A THIRD suite rather than a flag, matching `v2Suite`'s reasoning: the sheet
 * renders a genuinely different thing for it (rows disabled, with a reason that
 * outranks every permission and feature answer), and a harness that could only
 * produce editable suites would let that path rot.
 *
 * `declaredSuiteId` rather than `source: 'sdk'` because it is the half that
 * arrived later and is therefore the half a reader is most likely to forget —
 * both are covered by `isCiOwnedSuite`'s own unit tests.
 */
export const ciOwnedSuite: EvalSuite = {
  ...baseSuite,
  declaredSuiteId: "s_from_file",
};

export type SettingsSheetOverrides = Partial<
  React.ComponentProps<typeof SuiteIterationsView>
>;

export type SettingsNavOptions = {
  isVerdictPolicyV2?: boolean;
  showComputerEnvironment?: boolean;
  showSchedule?: boolean;
  showDelete?: boolean;
};

function settingsNavOptionsForSuite(
  suite: EvalSuite,
  overrides: SettingsNavOptions = {},
): Required<SettingsNavOptions> {
  return {
    isVerdictPolicyV2: overrides.isVerdictPolicyV2 ?? suite.verdictPolicyVersion === 2,
    showComputerEnvironment: overrides.showComputerEnvironment ?? true,
    showSchedule: overrides.showSchedule ?? true,
    showDelete: overrides.showDelete ?? true,
  };
}

function clickNavLabel(scope: ParentNode, label: string) {
  const nav = scope instanceof HTMLElement ? scope : null;
  if (!nav) throw new Error(`nav scope missing for ${label}`);
  for (const button of nav.querySelectorAll("button")) {
    if (button.textContent?.trim() === label) {
      fireEvent.click(button);
      return;
    }
  }
  throw new Error(`no nav button labeled ${label}`);
}

export function showSettingsGroup(
  container: HTMLElement,
  groupLabel: string,
) {
  const sections = container.querySelector(
    '[aria-label="Settings sections"]',
  );
  if (!sections) throw new Error("settings section tabs not found");
  clickNavLabel(sections, groupLabel);
}

export function showSettingsSubsection(
  container: HTMLElement,
  subsectionLabel: string,
) {
  const subsections = container.querySelector(
    '[aria-label="Settings subsections"]',
  );
  if (!subsections) return;
  clickNavLabel(subsections, subsectionLabel);
}

export function findGroupForSettingKey(
  key: EvalSuiteSettingKey,
): SuiteSettingsGroupId | undefined {
  for (const group of VISIBLE_SUITE_SETTINGS_GROUPS) {
    if ((group.rows as readonly string[]).includes(key)) return group.id;
    if (
      group.rows.some((row) => NESTED_SETTING_KEYS[row]?.includes(key))
    ) {
      return group.id;
    }
  }
  return undefined;
}

export function showSettingsKey(
  container: HTMLElement,
  key: EvalSuiteSettingKey,
  options: SettingsNavOptions = {},
  suite: EvalSuite = baseSuite,
) {
  if (key === "name") return;
  const groupId = findGroupForSettingKey(key);
  if (!groupId) throw new Error(`no settings group for ${key}`);
  const group = VISIBLE_SUITE_SETTINGS_GROUPS.find((candidate) => candidate.id === groupId);
  if (!group) throw new Error(`unknown group ${groupId}`);
  const navOptions = settingsNavOptionsForSuite(suite, options);
  const subsection = subsectionForSettingKey(key, groupId, navOptions);
  if (!subsection) throw new Error(`no subsection for ${key}`);
  showSettingsGroup(container, group.label);
  showSettingsSubsection(container, subsection.label);
}

export function collectAllSettingKeys(
  container: HTMLElement,
  suite: EvalSuite = baseSuite,
  options: SettingsNavOptions = {},
): string[] {
  const navOptions = settingsNavOptionsForSuite(suite, options);
  const keys = new Set<string>();
  for (const key of SUITE_SETTINGS_HEADER_KEYS) {
    if (container.querySelector(`[data-setting-key="${key}"]`)) {
      keys.add(key);
    }
  }
  for (const group of VISIBLE_SUITE_SETTINGS_GROUPS) {
    const subsections = getSubsectionsForGroup(group.id, navOptions);
    if (subsections.length === 0) continue;
    showSettingsGroup(container, group.label);
    for (const subsection of subsections) {
      showSettingsSubsection(container, subsection.label);
      for (const node of container.querySelectorAll("[data-setting-key]")) {
        const key = node.getAttribute("data-setting-key");
        if (key) keys.add(key);
      }
    }
  }
  return [...keys];
}

export function renderSettingsSheet(overrides: SettingsSheetOverrides = {}) {
  const element = (
    <SuiteIterationsView
      suite={baseSuite}
      cases={[]}
      iterations={[]}
      allIterations={[]}
      runs={[]}
      runsLoading={false}
      aggregate={null}
      onRerun={vi.fn()}
      onCancelRun={vi.fn()}
      onDelete={vi.fn()}
      onDeleteRun={vi.fn()}
      onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
      connectedServerNames={new Set()}
      canDeleteSuite
      rerunningSuiteId={null}
      cancellingRunId={null}
      deletingSuiteId={null}
      deletingRunId={null}
      availableModels={[]}
      organizationId="org-1"
      projectId="project-1"
      route={{ type: "suite-edit", suiteId: "suite-1" }}
      navigation={noopNav}
      {...overrides}
    />
  );
  const router = createMemoryRouter(
    [
      { path: "/", element },
      // A second route so a navigation test has somewhere to go.
      { path: "/elsewhere", element: <div data-testid="elsewhere" /> },
    ],
    { initialEntries: ["/"] }
  );
  return { ...render(<RouterProvider router={router} />), router };
}

/**
 * Wrap an already-built element in a data router.
 *
 * For the suites that build their own props and only need the router the
 * sheet's unsaved-changes guard requires. Same reason as above: the app is a
 * data router, and a test that renders the sheet without one is testing a
 * component in an environment it never actually runs in.
 */
/** Focus a settings section (always expanded in the ledger layout). */
export function openSettingsRow(container: HTMLElement, key: string) {
  if (key === "name") {
    const row = container.querySelector('[data-setting-key="name"]');
    if (!row) throw new Error("no header name editor");
    const trigger = row.querySelector<HTMLElement>('[aria-expanded="false"]');
    if (trigger) fireEvent.click(trigger);
    else {
      const button = row.querySelector<HTMLElement>("button");
      if (button) fireEvent.click(button);
    }
    return;
  }
  showSettingsKey(container, key as EvalSuiteSettingKey);
}

export function withDataRouter(element: React.ReactNode) {
  return (
    <RouterProvider
      router={createMemoryRouter([{ path: "/", element }], {
        initialEntries: ["/"],
      })}
    />
  );
}
