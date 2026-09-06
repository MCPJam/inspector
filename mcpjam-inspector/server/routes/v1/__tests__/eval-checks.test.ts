/**
 * The GitHub Checks route family: what it reads, what it refuses, and the one
 * backend function it is allowed to call.
 *
 * The last is not a style point. `github/checkRepoConfigs:connectRepo` sits
 * beside the verified action and is marked `@deprecated COMPATIBILITY ONLY —
 * the unverified connect path`; it cannot stamp an installation id, because
 * proving one needs a GitHub round trip a mutation cannot make. A new surface
 * calling it would silently grow the pile of unverified rows, and nothing but
 * a test would notice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://convex.test");
});

const queryMock = vi.fn();
const actionMock = vi.fn();

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    action(...args: unknown[]) {
      return actionMock(...args);
    }
    mutation() {
      throw new Error("unexpected mutation");
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
  getConvexBearerThunkForRequest: async () => async () => "convex-jwt",
}));

import evalChecks from "../eval-checks.js";
import { v1OnError } from "../envelope.js";
import { isGuestAllowedV1Request } from "../guest-allowed-paths.js";

const ORG = "org_1";
const BASE = `/api/v1/organizations/${ORG}/eval-check-repos`;

function makeApp() {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", evalChecks);
  return app;
}

const CONFIG_ROW = {
  _id: "cfg_1",
  repoFullName: "acme/widgets",
  enabled: true,
  organizationId: ORG,
  projectId: "proj_1",
  suiteId: "suite_1",
  outagePolicy: "fail_closed",
  createdAt: 1,
  updatedAt: 2,
};

/**
 * One entry as `checkRepoConfigsNode:listInstallationRepos` returns it.
 *
 * `installationRef` is the opaque Convex row id of the binding the repository
 * was enumerated through — never GitHub's installation id — and `repositoryId`
 * is GitHub's numeric identity, which is what a connect is re-verified
 * against. Both are SELECTORS the connect sends back; neither is a fact the
 * backend takes on trust.
 */
const LISTED_REPO = {
  fullName: "acme/widgets",
  repositoryId: 4242,
  installationRef: "inst_1",
  accountLogin: "acme",
  private: true,
};

function answer(
  queries: Record<string, unknown>,
  actions: Record<string, unknown> = {}
) {
  const pick = (table: Record<string, unknown>, name: string) => {
    const fn = String(name).split(":").pop() ?? "";
    if (Object.prototype.hasOwnProperty.call(table, fn)) {
      const value = table[fn];
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value);
    }
    return Promise.reject(new Error(`unexpected call ${String(name)}`));
  };
  queryMock.mockImplementation((name: string) => pick(queries, name));
  actionMock.mockImplementation((name: string) => pick(actions, name));
}

describe("GET eval-check-repos", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the connected rows and the connectable repositories", async () => {
    answer(
      {
        getGithubChecksSettingsAvailability: { state: "enabled" },
        listForOrganization: [CONFIG_ROW],
      },
      { listInstallationRepos: [{ fullName: "acme/widgets" }] }
    );
    const res = await makeApp().request(BASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.available).toBe(true);
    expect(body.items).toEqual([
      {
        id: "cfg_1",
        repo: "acme/widgets",
        enabled: true,
        suiteId: "suite_1",
        projectId: "proj_1",
        outagePolicy: "fail_closed",
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    expect(body.connectable).toEqual([{ repo: "acme/widgets" }]);
    // The row carries an installationId on the verified path; the DTO is an
    // explicit projection so infrastructure never rides out on a public read.
    expect(JSON.stringify(body)).not.toContain("installationId");
  });

  it("reports an unset outage policy as null, not as fail_open", async () => {
    // ABSENT means nobody chose. Reporting `fail_open` would say someone did.
    answer(
      {
        getGithubChecksSettingsAvailability: { state: "enabled" },
        listForOrganization: [{ ...CONFIG_ROW, outagePolicy: undefined }],
      },
      { listInstallationRepos: [] }
    );
    const body = (await (await makeApp().request(BASE)).json()) as any;
    expect(body.items[0].outagePolicy).toBeNull();
  });

  it("distinguishes an unavailable organization from an empty one", async () => {
    answer({ getGithubChecksSettingsAvailability: { state: "disabled" } });
    const body = (await (await makeApp().request(BASE)).json()) as any;
    expect(body.available).toBe(false);
    expect(body.items).toEqual([]);
    // Nothing else is even asked: no listing, no GitHub round trip.
    expect(actionMock).not.toHaveBeenCalled();
  });

  it("still lists what is connected when GitHub cannot be reached", async () => {
    // The connectable list costs a GitHub call; the connected list does not.
    // An outage in the first must not take down the second.
    answer(
      {
        getGithubChecksSettingsAvailability: { state: "enabled" },
        listForOrganization: [CONFIG_ROW],
      },
      { listInstallationRepos: new Error("GitHub is unavailable") }
    );
    const res = await makeApp().request(BASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items).toHaveLength(1);
    // `null` = could not ask. An empty array would claim the App reaches none.
    expect(body.connectable).toBeNull();
  });

  it("distinguishes a failed lookup from an empty one", async () => {
    // `[]` and `null` are DIFFERENT answers and the DTO documents them as
    // such: null = could not ask, [] = asked and got nothing. The empty case
    // also covers a deployment with no GitHub App installed, because the
    // platform returns [] for that too — so this pins the one distinction the
    // boundary can actually make, and no more.
    answer(
      {
        getGithubChecksSettingsAvailability: { state: "enabled" },
        listForOrganization: [],
      },
      { listInstallationRepos: [] }
    );
    const body = (await (await makeApp().request(BASE)).json()) as any;
    expect(body.connectable).toEqual([]);
    expect(body.connectable).not.toBeNull();
  });

  it("does NOT swallow a failure of the connected list", async () => {
    // The converse of the case above, and the other half of the design claim
    // in this file's header: the connectable list is allowed to fail soft
    // because it costs a GitHub call, the connected list is not. Reporting an
    // empty `items` for a failed read would say "nothing is connected".
    answer(
      {
        getGithubChecksSettingsAvailability: { state: "enabled" },
        listForOrganization: new Error("convex unavailable"),
      },
      { listInstallationRepos: [] }
    );
    const res = await makeApp().request(BASE);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("POST eval-check-repos", () => {
  beforeEach(() => vi.clearAllMocks());

  function connect(body: unknown) {
    return makeApp().request(BASE, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("connects through the VERIFIED action, never the deprecated mutation", async () => {
    answer(
      {},
      {
        listInstallationRepos: [LISTED_REPO],
        connectVerifiedRepo: { configId: "cfg_9" },
      },
    );
    const res = await connect({
      projectId: "proj_1",
      suiteId: "suite_1",
      repo: "acme/widgets",
      outagePolicy: "fail_closed",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      id: "cfg_9",
      organizationId: ORG,
      suiteId: "suite_1",
      repo: "acme/widgets",
      outagePolicy: "fail_closed",
    });
    // The unverified path cannot stamp an installation id, so a row created
    // through it is permanently unverifiable. Nothing here may reach it.
    const called = actionMock.mock.calls.map((call) => String(call[0]));
    expect(called.some((name) => name.endsWith(":connectRepo"))).toBe(false);
  });

  it("forwards the installationRef AND repositoryId from the listing", async () => {
    // THE BUG THIS FILE'S POST HALF EXISTS FOR.
    //
    // `connectVerifiedRepo` reads an ABSENT `installationRef` as "use the
    // pinned compatibility branch", which resolves the retired
    // `GITHUB_CHECKS_INSTALLATION_ID` env var. That var is unset in
    // production, so a reference-less connect refused every time — while the
    // GET beside this listed the very same repository as `connectable`. The
    // web picker never hit it because it sends the reference it read out of
    // the listing; every agent surface did, because it has no picker.
    //
    // So the assertion is on BOTH selectors, not just the ref: the ref picks
    // the binding, and the numeric id is what GitHub's own answer is checked
    // against, which is the guard that catches a rename-and-reuse race between
    // the listing and this connect.
    answer(
      {},
      {
        listInstallationRepos: [LISTED_REPO],
        connectVerifiedRepo: { configId: "cfg_9" },
      },
    );
    const res = await connect({
      projectId: "proj_1",
      suiteId: "suite_1",
      repo: "acme/widgets",
      outagePolicy: "fail_closed",
    });
    expect(res.status).toBe(201);
    expect(actionMock).toHaveBeenCalledWith(
      "github/checkRepoConfigsNode:connectVerifiedRepo",
      {
        organizationId: ORG,
        projectId: "proj_1",
        suiteId: "suite_1",
        repoFullName: "acme/widgets",
        outagePolicy: "fail_closed",
        installationRef: "inst_1",
        repositoryId: 4242,
      },
    );
  });

  it("matches the repository the way the backend keys it: case-insensitively", async () => {
    // The stored key is `canonicalizeRepoFullName` — trim + lowercase — so
    // `Acme/Widgets` and `acme/widgets` are one repository under one row. A
    // case-sensitive match here would refuse a name a human typed correctly.
    answer(
      {},
      {
        listInstallationRepos: [LISTED_REPO],
        connectVerifiedRepo: { configId: "cfg_9" },
      },
    );
    const res = await connect({
      projectId: "proj_1",
      suiteId: "suite_1",
      repo: "  Acme/Widgets  ",
      outagePolicy: "fail_open",
    });
    expect(res.status).toBe(201);
    expect(actionMock).toHaveBeenCalledWith(
      "github/checkRepoConfigsNode:connectVerifiedRepo",
      expect.objectContaining({
        installationRef: "inst_1",
        repositoryId: 4242,
      }),
    );
  });

  it("sends NEITHER selector for a listing entry that carries no reference", async () => {
    // The pinned compatibility branch lists repositories without an
    // `installationRef`. That branch only produces entries at all when the pin
    // IS set, so sending nothing is correct AND functional there — and the
    // backend documents "no reference" as a byte-identical path, which a
    // stray `repositoryId` would quietly stop being.
    answer(
      {},
      {
        listInstallationRepos: [
          { fullName: "acme/widgets", repositoryId: 4242 },
        ],
        connectVerifiedRepo: { configId: "cfg_9" },
      },
    );
    const res = await connect({
      projectId: "proj_1",
      suiteId: "suite_1",
      repo: "acme/widgets",
      outagePolicy: "fail_closed",
    });
    expect(res.status).toBe(201);
    expect(actionMock).toHaveBeenCalledWith(
      "github/checkRepoConfigsNode:connectVerifiedRepo",
      {
        organizationId: ORG,
        projectId: "proj_1",
        suiteId: "suite_1",
        repoFullName: "acme/widgets",
        outagePolicy: "fail_closed",
      },
    );
  });

  it("refuses a repository the listing does not hold, without disclosing what it does", async () => {
    answer(
      {},
      {
        listInstallationRepos: [
          { ...LISTED_REPO, fullName: "acme/secret-thing" },
        ],
        connectVerifiedRepo: { configId: "cfg_9" },
      },
    );
    const res = await connect({
      projectId: "proj_1",
      suiteId: "suite_1",
      repo: "acme/widgets",
      outagePolicy: "fail_closed",
    });
    expect(res.status).toBe(404);
    const raw = await res.text();
    // ONE flat sentence for "does not exist", "is somebody else's" and "the
    // App cannot see it". Telling them apart would answer "does this private
    // repository exist" for anyone who can reach the route.
    expect(raw).toContain(
      "Repository, project or suite not found, or the MCPJam GitHub App cannot reach it.",
    );
    // And the candidates are not the caller's business either — an error that
    // helpfully listed them would be the same oracle by another route.
    expect(raw).not.toContain("secret-thing");
    // Nothing was attempted: no GitHub verification round trip, no row.
    const called = actionMock.mock.calls.map((call) => String(call[0]));
    expect(called).not.toContain(
      "github/checkRepoConfigsNode:connectVerifiedRepo",
    );
  });

  it("refuses an AMBIGUOUS match rather than picking one", async () => {
    // The backend deduplicates its fan-out across bindings by NUMERIC
    // repository id, NOT by name, so two entries can legitimately carry one
    // full name — a renamed repository whose freed name was taken in another
    // account the App is also installed on. Picking either would stamp the row
    // with an installation that may not be the one the caller meant, and the
    // row's key is the name, so the mistake would only ever surface as checks
    // that silently never run.
    answer(
      {},
      {
        listInstallationRepos: [
          { ...LISTED_REPO, installationRef: "inst_1", repositoryId: 4242 },
          { ...LISTED_REPO, installationRef: "inst_2", repositoryId: 9999 },
        ],
        connectVerifiedRepo: { configId: "cfg_9" },
      },
    );
    const res = await connect({
      projectId: "proj_1",
      suiteId: "suite_1",
      repo: "acme/widgets",
      outagePolicy: "fail_closed",
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(
      "Repository, project or suite not found, or the MCPJam GitHub App cannot reach it.",
    );
    const called = actionMock.mock.calls.map((call) => String(call[0]));
    expect(called).not.toContain(
      "github/checkRepoConfigsNode:connectVerifiedRepo",
    );
  });

  it("does NOT fall through to the broken no-reference path when the listing fails", async () => {
    // The GET fails SOFT on this same call, because the connected list costs
    // no GitHub round trip and must survive an outage. The POST cannot: there
    // is nothing left to preserve, and continuing without a reference would
    // take the retired compatibility branch and answer "not accessible" —
    // turning a GitHub blip into the exact misleading refusal that sends an
    // admin off to re-install an App which is installed fine.
    //
    // The backend's own refusal keeps its wording, so the caller is told to
    // retry rather than to go and fix something that is not broken.
    const refusal = Object.assign(
      new Error("Could not list repositories from GitHub."),
      { data: "Could not list repositories from GitHub." },
    );
    answer(
      {},
      {
        listInstallationRepos: refusal,
        connectVerifiedRepo: { configId: "cfg_9" },
      },
    );
    const res = await connect({
      projectId: "proj_1",
      suiteId: "suite_1",
      repo: "acme/widgets",
      outagePolicy: "fail_closed",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const raw = await res.text();
    expect(raw).toContain("Could not list repositories from GitHub.");
    // The refusal that must NOT be produced for an outage.
    expect(raw).not.toContain("cannot reach it");
    // Nothing was written, and nothing tried the reference-less branch.
    const called = actionMock.mock.calls.map((call) => String(call[0]));
    expect(called).not.toContain(
      "github/checkRepoConfigsNode:connectVerifiedRepo",
    );
  });

  it("requires an explicit outage policy", async () => {
    // The app's connect surfaces refuse to enable their button without one,
    // precisely so no surface quietly produces rows nobody chose a policy for.
    // An agent would take a default every single time.
    answer({}, { connectVerifiedRepo: { configId: "cfg_9" } });
    const res = await connect({
      projectId: "proj_1",
      suiteId: "suite_1",
      repo: "acme/widgets",
    });
    expect(res.status).toBe(400);
    expect(actionMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown policy", { outagePolicy: "fail_sometimes" }],
    ["an unknown key", { retries: 3 }],
  ])("rejects %s", async (_label, extra) => {
    answer({}, { connectVerifiedRepo: { configId: "cfg_9" } });
    const res = await connect({
      projectId: "proj_1",
      suiteId: "suite_1",
      repo: "acme/widgets",
      outagePolicy: "fail_open",
      ...extra,
    });
    expect(res.status).toBe(400);
    expect(actionMock).not.toHaveBeenCalled();
  });
});

describe("guest boundary", () => {
  it("keeps both check-repo routes guest-closed", () => {
    // Connecting reaches a shared repository and can block merges; the read
    // enumerates an organization's repositories. Neither is a guest's business,
    // and default-deny already covers them — asserted so an allowlist edit has
    // to break this test to reach them.
    expect(isGuestAllowedV1Request("GET", BASE)).toBe(false);
    expect(isGuestAllowedV1Request("POST", BASE)).toBe(false);
  });
});
