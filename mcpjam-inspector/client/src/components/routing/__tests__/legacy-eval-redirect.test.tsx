import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { LegacyEvalRedirect } from "../legacy-eval-redirect";

const project = "/p/k5700000000000000000000000a";
afterEach(cleanup);

describe("legacy Evaluate links", () => {
  for (const scope of ["", project]) {
    it.each([
      ["evals", "/evaluate"],
      ["evals/runs", "/evaluate/runs"],
      ["ci-evals", "/evaluate/runs"],
    ])(`opens ${scope}/%s on its tab, query and hash kept`, async (prefix, target) => {
      const routes = [
        { path: `${prefix}/*`, element: <LegacyEvalRedirect /> },
        { path: "evaluate/*", element: <div>Evaluate</div> },
      ];
      const router = createMemoryRouter([
        ...routes, { path: "p/:projectId", children: routes },
      ], { initialEntries: [`${scope}/${prefix}?project=P#top`] });
      render(<RouterProvider router={router} />);
      await waitFor(() => {
        const { pathname, search, hash } = router.state.location;
        expect(`${pathname}${search}${hash}`).toBe(`${scope}${target}?project=P#top`);
      });
      expect(router.state.historyAction).toBe("REPLACE");
      router.dispose();
    });

    for (const prefix of ["evals", "evals/runs", "ci-evals"]) {
      it.each([
        ["/suite/S%201", "?view=test-cases", "?view=test-cases"],
        ["/suite/S/runs/R", "?iteration=I&case=C&compareTo=R2#trace", "?iteration=I&case=C&compareTo=R2#trace"],
        ["/suite/S/test/T/edit", "?compare=1#trace", "?compare=1#trace"],
      ])(`preserves the exact target for ${scope}/${prefix}%s`, async (tail, suffix, expectedSuffix) => {
        const routes = [
          { path: `${prefix}/*`, element: <LegacyEvalRedirect /> },
          { path: "evaluate/*", element: <div>Evaluate</div> },
        ];
        const router = createMemoryRouter([
          ...routes, { path: "p/:projectId", children: routes },
        ], { initialEntries: [`${scope}/${prefix}${tail}${suffix}`] });
        render(<RouterProvider router={router} />);
        await waitFor(() => {
          const { pathname, search, hash } = router.state.location;
          expect(`${pathname}${search}${hash}`).toBe(`${scope}/evaluate${tail}${expectedSuffix}`);
        });
        expect(router.state.historyAction).toBe("REPLACE");
        router.dispose();
      });
    }

    it.each(["evals/runs", "ci-evals"])(`opens the Runs tab for ${scope}/%s/commit`, async (prefix) => {
      const routes = [
        { path: `${prefix}/*`, element: <LegacyEvalRedirect /> },
        { path: "evaluate/runs", element: <div>Runs table</div> },
      ];
      const router = createMemoryRouter([
        ...routes, { path: "p/:projectId", children: routes },
      ], { initialEntries: [`${scope}/${prefix}/commit/abc?project=P&suite=S&iteration=I&origin=sdk#case`] });
      render(<RouterProvider router={router} />);
      await waitFor(() => {
        expect(router.state.location.pathname).toBe(`${scope}/evaluate/runs`);
        expect(router.state.location.search).toBe("?project=P");
        expect(router.state.location.hash).toBe("");
      });
      router.dispose();
    });
  }
});
