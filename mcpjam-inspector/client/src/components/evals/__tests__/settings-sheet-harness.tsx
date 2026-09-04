import { render } from "@testing-library/react";
import { vi } from "vitest";
import {
  createMemoryRouter,
  RouterProvider,
} from "react-router";
import { SuiteIterationsView } from "../suite-iterations-view";
import type { EvalSuite } from "../types";

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

export type SettingsSheetOverrides = Partial<
  React.ComponentProps<typeof SuiteIterationsView>
>;

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
export function withDataRouter(element: React.ReactNode) {
  return (
    <RouterProvider
      router={createMemoryRouter([{ path: "/", element }], {
        initialEntries: ["/"],
      })}
    />
  );
}
