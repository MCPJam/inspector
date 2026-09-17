import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { LegacyEvalCaseRedirect } from "../legacy-eval-case-redirect";

const project = "/p/k5700000000000000000000000a";
const suffix = "?compare=1&iteration=iteration1#trace";

function setup(initialEntry: string) {
  const legacy = ["evals", "evals/runs"].flatMap((prefix) =>
    ["", "/edit"].map((edit) => ({
      path: `${prefix}/suite/:suiteId/test/:testId${edit}`,
      element: <LegacyEvalCaseRedirect />,
    })),
  );
  const routes = [
    ...legacy,
    { path: "evaluate/*", element: <div>Ding Dong</div> },
  ];
  const router = createMemoryRouter(
    [
      ...routes,
      { path: "p/:projectId", children: routes },
      { path: "start", element: <div>Start</div> },
    ],
    { initialEntries: [initialEntry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

function currentUrl(router: ReturnType<typeof setup>) {
  const { pathname, search, hash } = router.state.location;
  return `${pathname}${search}${hash}`;
}

afterEach(cleanup);

describe("legacy case redirects", () => {
  for (const scope of ["", project]) {
    for (const prefix of ["evals", "evals/runs"]) {
      it.each([
        ["suite/S%201/test/C%202", ""],
        ["suite/S%201/test/C%202/", ""],
        ["Suite/S%201/Test/C%202///", ""],
        ["Suite/S%201/Test/C%202/EDIT/", "/edit"],
      ])(`preserves context for ${scope}/${prefix}/%s`, async (tail, edit) => {
        const router = setup(`${scope}/${prefix.toUpperCase()}/${tail}${suffix}`);
        await waitFor(() => {
          expect(currentUrl(router)).toBe(
            `${scope}/evaluate/suite/S%201/test/C%202${edit}${suffix}`,
          );
        });
        expect(router.state.historyAction).toBe("REPLACE");
        router.dispose();
      });
    }
  }

  it("keeps the destination fragment during in-app navigation", async () => {
    const router = setup("/start#old-fragment");
    await act(async () => {
      await router.navigate(`${project}/evals/runs/suite/S/test/C/edit${suffix}`);
    });
    await waitFor(() => {
      expect(currentUrl(router)).toBe(
        `${project}/evaluate/suite/S/test/C/edit${suffix}`,
      );
    });
    await act(async () => { await router.navigate(-1); });
    expect(currentUrl(router)).toBe("/start#old-fragment");
    router.dispose();
  });
});
