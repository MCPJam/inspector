/**
 * Mounts the real Evaluate tab behind the real old-address gate inside a data
 * router, as `router.tsx` registers it under `/p/:projectId`, and checks each
 * page the walk lands on.
 *
 * A data router matters: RouterProvider commits every navigation inside a
 * transition, so a page that keeps re-rendering never lets the next page
 * swap in. A bare page or a MemoryRouter cannot show that.
 */
import { Profiler } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";
import { APP_ROUTES } from "@/lib/app-routes";
import { EvaluateLegacyRedirectGate } from "../routing/evaluate-legacy-redirect";
import { NotFoundRoute } from "../routing/not-found-route";
import { EvaluateTab } from "../EvaluateTab";

/** Every APP_ROUTES path with scope "project" that starts with "evaluate". */
export const EVALUATE_ROUTE_PATHS: readonly string[] = APP_ROUTES.filter(
  (route) => route.scope === "project" && route.path.startsWith("evaluate"),
).map((route) => route.path);

export const QUIET_WINDOW_MS = 150;
export const QUIET_COMMIT_BUDGET = 0;
export const STEP_COMMIT_BUDGET = 60;
export const DECISION_READ_GUARD = 1000;

/** How long a page may take to replace the last one before the step fails. */
const PAGE_TIMEOUT_MS = 5000;

export interface FlowApp {
  router: ReturnType<typeof createMemoryRouter>;
  user: ReturnType<typeof userEvent.setup>;
  /** React Profiler commits since render, across the whole tree. */
  commits(): number;
  /** pathname + search + hash of router.state.location. */
  location(): string;
}

export interface PageExpectation {
  /** Full expected location, e.g. projectUrl("/evaluate/suite/suite-excalidraw/settings"). */
  url: string;
  /** data-testid that only this page renders. */
  marker: string;
  /** Crumb labels in order; [] = no breadcrumb nav on the page. The last one is the current page. */
  crumbs: readonly string[];
  /** Back button title, or null = no Back button. */
  back: string | null;
  /** Marker of the page navigated away from; must be gone. */
  previousMarker?: string;
}

const ensureServersReady = vi.fn(async (serverNames: string[]) => ({
  readyServerNames: serverNames,
  missingServerNames: [],
  failedServerNames: [],
  reauthServerNames: [],
}));

function EvaluateHarnessRoute() {
  const { projectId } = useParams();
  return (
    <EvaluateLegacyRedirectGate>
      <EvaluateTab
        projectId={projectId}
        ensureServersReady={ensureServersReady}
        onContinueInChat={vi.fn()}
        handleConnect={vi.fn()}
      />
    </EvaluateLegacyRedirectGate>
  );
}

/** Mirrors the project subtree in `router.tsx`: one child per Evaluate path, then `*`. */
export function renderEvaluateApp(initialUrl: string): FlowApp {
  const router = createMemoryRouter(
    [
      {
        path: "p/:projectId",
        children: [
          ...EVALUATE_ROUTE_PATHS.map((path) => ({
            path,
            element: <EvaluateHarnessRoute />,
          })),
          { path: "*", element: <NotFoundRoute /> },
        ],
      },
    ],
    { initialEntries: [initialUrl] },
  );
  let commits = 0;
  render(
    <Profiler id="evaluate-flow" onRender={() => (commits += 1)}>
      <RouterProvider router={router} />
    </Profiler>,
  );
  return {
    router,
    user: userEvent.setup(),
    commits: () => commits,
    location: () => {
      const { pathname, search, hash } = router.state.location;
      return `${pathname}${search}${hash}`;
    },
  };
}

function breadcrumbNav(): HTMLElement | null {
  return document.querySelector<HTMLElement>('nav[aria-label="breadcrumb"]');
}

/** Labels of the breadcrumb nav, skipping separators and the folded "…" item. */
export function readTrail(): string[] {
  const nav = breadcrumbNav();
  if (!nav) return [];
  return Array.from(
    nav.querySelectorAll<HTMLElement>('[data-slot="breadcrumb-item"]'),
  ).map((item) => (item.textContent ?? "").trim());
}

function backButton(): HTMLElement | null {
  const header = screen.queryByTestId("evals-header");
  if (!header) return null;
  return header.querySelector<HTMLElement>('button[title^="Back to "]');
}

/** Clicks the crumb button with this label inside nav[aria-label="breadcrumb"]. */
export async function clickCrumb(app: FlowApp, label: string): Promise<void> {
  const nav = breadcrumbNav();
  if (!nav) throw new Error(`no breadcrumb to click "${label}" in`);
  await app.user.click(within(nav).getByRole("button", { name: label }));
}

/** Clicks the Back button inside the page's header strip. */
export async function clickBack(app: FlowApp): Promise<void> {
  const button = backButton();
  if (!button) throw new Error("no Back button on this page");
  await app.user.click(button);
}

async function quietWindow(app: FlowApp): Promise<void> {
  const settled = app.commits();
  await act(
    () => new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS)),
  );
  expect(
    app.commits() - settled,
    `commits within ${QUIET_WINDOW_MS} ms after ${app.location()} settled`,
  ).toBeLessThanOrEqual(QUIET_COMMIT_BUDGET);
}

async function waitForPage(
  app: FlowApp,
  expected: PageExpectation,
): Promise<void> {
  await waitFor(
    () => {
      expect(app.location()).toBe(expected.url);
      expect(screen.getByTestId(expected.marker)).toBeInTheDocument();
      if (
        expected.previousMarker &&
        expected.previousMarker !== expected.marker
      )
        expect(screen.queryByTestId(expected.previousMarker)).toBeNull();
      // Pages fill their trail once their own data answers.
      expect(readTrail()).toEqual(expected.crumbs);
      expect(backButton()?.getAttribute("title") ?? null).toBe(expected.back);
    },
    { timeout: PAGE_TIMEOUT_MS },
  );
}

/** Waits for url + marker, then asserts previousMarker gone, crumbs, back, and the quiet window. */
export async function expectPage(
  app: FlowApp,
  expected: PageExpectation,
): Promise<void> {
  await waitForPage(app, expected);
  if (expected.crumbs.length === 0)
    expect(breadcrumbNav(), "a page without a trail").toBeNull();
  await quietWindow(app);
}

/** Clicks, then expectPage; also asserts commits from click to settle <= STEP_COMMIT_BUDGET. */
export async function step(
  app: FlowApp,
  click: () => Promise<void>,
  expected: PageExpectation,
): Promise<void> {
  const before = app.commits();
  await click();
  await waitForPage(app, expected);
  const used = app.commits() - before;
  expect(used, `commits from click to ${expected.url}`).toBeLessThanOrEqual(
    STEP_COMMIT_BUDGET,
  );
  await quietWindow(app);
}
