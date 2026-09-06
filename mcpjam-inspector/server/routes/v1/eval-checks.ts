/**
 * GitHub Checks for eval suites — "run this suite on every pull request".
 *
 * ITS OWN ROUTE FAMILY, and not a field on the suite PATCH, because the
 * resource is ORG-scoped: a connection binds an organization's GitHub App
 * installation to a repository, and the suite is only which suite that
 * repository answers for. Modelling it as a suite setting would have put an
 * organization-wide write behind a suite id, and made "connect" and "retarget
 * a repository at a different suite" the same request.
 *
 * DELIBERATELY NARROWER than Settings → Integrations, mirroring the suite-side
 * section this exposes (`client/src/components/evals/suite-github-checks-section.tsx`):
 * connect this suite to a repository, and see what is connected. Pausing,
 * retargeting and disconnecting are repo-level decisions that want every repo
 * visible at once — offering them here would let a caller retarget a repository
 * away from the suite it is standing on, which reads as a mistake even when it
 * is not.
 *
 * The connect goes through `github/checkRepoConfigsNode:connectVerifiedRepo`,
 * never the `checkRepoConfigs:connectRepo` mutation beside it: that one is
 * marked `@deprecated COMPATIBILITY ONLY — the unverified connect path` and
 * cannot stamp an installation id, because proving one needs a GitHub round
 * trip a mutation cannot make. A new surface must not add rows to the
 * unverified pile.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { parseWithSchema, ErrorCode, WebRouteError } from "../web/errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { v1Resource } from "./envelope.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import { logger } from "../../utils/logger.js";

const evalChecks = new Hono();

/**
 * The one sentence this route answers with when the repository a caller named
 * is not one it can connect.
 *
 * FLAT ON PURPOSE, and shared by the refusal below AND by the `notFoundMessage`
 * the backend's own refusals are translated into, so the two cannot drift into
 * two distinguishable answers. A repository that does not exist, one that
 * exists in somebody else's account, and one this organization's installations
 * cannot see must all read the same — otherwise the endpoint becomes an oracle
 * for private repository names for anyone who can reach it. The backend words
 * its half of this the same way and for the same reason; see
 * `REPO_NOT_ACCESSIBLE_MESSAGE` in `github/checkRepoConfigsNode.ts`.
 */
const REPO_NOT_CONNECTABLE_MESSAGE =
  "Repository, project or suite not found, or the MCPJam GitHub App cannot reach it.";

/**
 * The key a repository full name is compared on.
 *
 * Mirrors the backend's `canonicalizeRepoFullName` (trim + lowercase) exactly,
 * because that is the spelling a connected row is STORED and looked up under.
 * Matching case-sensitively here would refuse `Acme/Widgets` for a listing that
 * says `acme/widgets` — the same repository, under the same stored key — and an
 * agent surface types a name a human gave it rather than one it copied out of a
 * picker.
 */
function canonicalRepoKey(raw: string): string {
  return raw.trim().toLowerCase();
}

function convexClient(token: string): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration",
    );
  }
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  return client;
}

/**
 * One connected repository. Explicit projection, not a pass-through: the row
 * carries an `installationId` on the verified path, and an installation id is
 * the one field on it that names infrastructure rather than configuration.
 *
 * `outagePolicy: null` is a REAL state, not a missing value to default away.
 * It means nobody chose a policy — the row predates the choice — and the
 * effective behaviour is `fail_open`. Reporting `fail_open` for it would say
 * someone picked that.
 */
function toCheckRepoDto(row: Record<string, any>) {
  return {
    id: String(row._id ?? ""),
    repo: String(row.repoFullName ?? ""),
    enabled: row.enabled === true,
    suiteId: row.suiteId ? String(row.suiteId) : null,
    projectId: row.projectId ? String(row.projectId) : null,
    outagePolicy:
      row.outagePolicy === "fail_open" || row.outagePolicy === "fail_closed"
        ? row.outagePolicy
        : null,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : null,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
  };
}

const connectCheckRepoSchema = z
  .object({
    projectId: z.string().min(1),
    suiteId: z.string().min(1),
    /** `owner/repo`. Canonicalized and VERIFIED server-side before it is stored. */
    repo: z.string().min(1),
    /**
     * REQUIRED here, though the backend leaves it optional for a deploy window.
     *
     * The suite-side UI requires an explicit choice before it will enable its
     * button, precisely so that surface is not the one quietly producing rows
     * nobody picked a policy for. An agent surface that defaulted it would be
     * exactly that path — and unlike a person, an agent will take the default
     * every time.
     */
    outagePolicy: z.enum(["fail_open", "fail_closed"]),
  })
  .strict();

// GET /v1/organizations/:organizationId/eval-check-repos
// The repositories in this organization that run an eval suite on their pull
// requests. Empty when GitHub Checks is not available for the organization —
// the backend answers an empty list rather than refusing, which is a truthful
// answer to "what may I see here".
evalChecks.get(
  "/organizations/:organizationId/eval-check-repos",
  async (c) => {
    const organizationId = c.req.param("organizationId");
    const client = convexClient(await getConvexBearerForRequest(c));

    let availability: { state?: string } | null = null;
    try {
      availability = await client.query(
        "github/checkRepoConfigs:getGithubChecksSettingsAvailability" as any,
        { organizationId } as any,
      );
    } catch (error) {
      throw translateConvexReadError(error, { scope: "v1.evalChecks" });
    }

    // Availability travels in the response rather than being flattened into an
    // empty list: "not enabled for this organization" and "enabled, nothing
    // connected" are different situations, and only one of them is fixed by
    // connecting a repository.
    const enabled = availability?.state === "enabled";
    if (!enabled) {
      return v1Resource(c, {
        organizationId,
        available: false,
        items: [],
        connectable: null,
      });
    }

    let rows: Array<Record<string, any>>;
    try {
      rows = ((await client.query(
        "github/checkRepoConfigs:listForOrganization" as any,
        { organizationId } as any,
      )) ?? []) as Array<Record<string, any>>;
    } catch (error) {
      throw translateConvexReadError(error, { scope: "v1.evalChecks" });
    }

    // The repositories the App can actually reach — the choices a connect has.
    // This one costs a GitHub round trip, so it FAILS SOFT: a failed lookup
    // returns `connectable: null` (meaning "could not ask") rather than taking
    // down the list of what is already connected, which needs no GitHub at all.
    //
    // `[]` is NOT the same answer, and is not only "the App reaches nothing":
    // a deployment with no GitHub App installation configured returns an empty
    // list too (`checkRepoConfigsNode:listInstallationRepos` short-circuits on
    // a null installation id). The platform does not distinguish those, so this
    // boundary cannot either — say so rather than implying a distinction the
    // wire does not carry.
    let connectable: Array<{ repo: string }> | null = null;
    try {
      const repos = ((await client.action(
        "github/checkRepoConfigsNode:listInstallationRepos" as any,
        { organizationId } as any,
      )) ?? []) as Array<Record<string, any>>;
      connectable = repos.map((repo) => ({
        repo: String(repo.fullName ?? repo.repoFullName ?? ""),
      }));
    } catch (error) {
      // Fail SOFT, but never silent: the caller still gets the connected list,
      // and the reason the other half is missing reaches the logs rather than
      // being inferred from a `null` nobody can explain.
      reportRouteFailure(
        "[v1.evalChecks] installation repositories unavailable",
        error,
        {
          source: "v1.evalChecks.listInstallationRepos",
          hop: "mcpjam_internal",
        },
      );
      connectable = null;
    }

    return v1Resource(c, {
      organizationId,
      available: true,
      items: rows.map(toCheckRepoDto),
      connectable,
    });
  },
);

// POST /v1/organizations/:organizationId/eval-check-repos
// Connect a repository so its pull requests run one eval suite.
evalChecks.post(
  "/organizations/:organizationId/eval-check-repos",
  async (c) => {
    const organizationId = c.req.param("organizationId");
    const raw = await c.req.text();
    let parsedBody: unknown;
    try {
      parsedBody = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Request body must be valid JSON.",
      );
    }
    const body = parseWithSchema(connectCheckRepoSchema, parsedBody);
    const client = convexClient(await getConvexBearerForRequest(c));

    const writeErrorOptions = {
      resource: "GitHub Checks repository",
      // The backend words these refusals deliberately — "install the App on
      // that repository" is different advice from "try again" — and it words
      // them the same for a repository that does not exist as for one the
      // App cannot see, on purpose: answering differently would turn this
      // into an oracle for private repository names.
      notFoundMessage: REPO_NOT_CONNECTABLE_MESSAGE,
      fallbackMessage: "GitHub Checks connection rejected by the platform",
      adminFailureIsForbidden: false,
    };

    // ── Resolve WHICH installation this repository is being connected through ─
    //
    // `connectVerifiedRepo` takes an optional `installationRef` naming one of
    // the organization's active bindings. Sending nothing does not mean "pick
    // one for me": it selects the action's PINNED COMPATIBILITY BRANCH, which
    // resolves the deployment-level `GITHUB_CHECKS_INSTALLATION_ID` env var —
    // deliberately retired, and unset in production. So every reference-less
    // connect refused with "Repository is not accessible to the MCPJam GitHub
    // App." while the GET on this very route listed that same repository as
    // `connectable` one request earlier. The web UI never hit it because its
    // picker sends the reference it read out of the listing; every agent
    // surface did, because it has no picker to read.
    //
    // The fix is to do here what the picker does there: resolve the name
    // against the same listing, and send the reference it carries. This route
    // already exposes that listing on the GET beside this, so it grants a
    // caller nothing they could not already enumerate — it just stops making
    // them the one who has to carry infrastructure identifiers around.
    let installationRepos: Array<Record<string, any>>;
    try {
      installationRepos = ((await client.action(
        "github/checkRepoConfigsNode:listInstallationRepos" as any,
        { organizationId } as any,
      )) ?? []) as Array<Record<string, any>>;
    } catch (error) {
      // FAILS HARD, unlike the same call on the GET.
      //
      // There it fails soft to `connectable: null` because the connected list
      // costs no GitHub call and must survive an outage. Here there is nothing
      // to preserve: continuing without a reference would take the retired
      // compatibility branch and answer "not accessible" — turning a GitHub
      // blip into the exact misleading refusal this change exists to remove,
      // and sending an admin off to re-install an App that is installed fine.
      //
      // Translated with the WRITE translator and the connect's own options, so
      // no new copy is invented: the backend's own "Could not list
      // repositories from GitHub." refusal keeps its retry advice, a
      // membership or availability refusal maps exactly as the connect below
      // would have mapped it, and a transport failure still answers 5xx. The
      // read translator would flatten the first of those into a generic 502
      // and page for somebody else's outage.
      throw translateConvexWriteError(error, writeErrorOptions);
    }

    const wanted = canonicalRepoKey(body.repo);
    const matches = installationRepos.filter(
      (repo) =>
        canonicalRepoKey(String(repo.fullName ?? repo.repoFullName ?? "")) ===
        wanted,
    );

    if (matches.length > 1) {
      // AMBIGUOUS, and refused rather than resolved by picking one.
      //
      // The backend deduplicates its fan-out across bindings by NUMERIC
      // repository id, not by name, so two entries CAN carry one full name —
      // a renamed repository whose freed name was taken in another account the
      // App is also installed on, or one binding serving a stale listing.
      // Picking either would stamp the row with an installation that may not
      // be the one the caller meant, and the row's key is the name, so the
      // mistake would only surface as checks that never run.
      //
      // The caller is told the same flat sentence as any other refusal: which
      // accounts hold a same-named repository is exactly the kind of thing
      // this endpoint must not narrate. The operator gets the diagnosis —
      // `logger.warn` is Axiom-only, so a rare but confusing refusal becomes
      // visible without paging anybody.
      logger.warn("[v1.evalChecks] ambiguous repository selection", {
        scope: "v1.evalChecks",
        organizationId,
        matches: matches.length,
      });
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        REPO_NOT_CONNECTABLE_MESSAGE,
      );
    }

    const selected = matches[0];
    if (!selected) {
      // Not in the listing: the repository does not exist, is somebody else's,
      // or no installation of this organization can reach it. ONE answer for
      // all three — see `REPO_NOT_CONNECTABLE_MESSAGE`. The candidate list is
      // never echoed back, for the same reason.
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        REPO_NOT_CONNECTABLE_MESSAGE,
      );
    }

    // ABSENT is a real, working case, not a failure to handle: entries listed
    // through the pinned compatibility branch carry no `installationRef`, and
    // that branch only produces entries at all when the pin IS set. So sending
    // nothing there is both correct and functional, and it keeps "no
    // reference" the byte-identical path the backend documents it as rather
    // than a second, slightly different way to write a verified row.
    const installationRef =
      typeof selected.installationRef === "string" &&
      selected.installationRef.length > 0
        ? selected.installationRef
        : undefined;
    // Sent ALONGSIDE the ref and never without it — the action only consults it
    // on the reference path, where it re-checks the id against GitHub's own
    // answer and refuses a mismatch. That check is the point: it catches a
    // rename-and-reuse race between the listing and this connect.
    const repositoryId =
      installationRef !== undefined &&
      typeof selected.repositoryId === "number" &&
      Number.isInteger(selected.repositoryId)
        ? selected.repositoryId
        : undefined;

    let result: { configId?: string } | null;
    try {
      result = await client.action(
        "github/checkRepoConfigsNode:connectVerifiedRepo" as any,
        {
          organizationId,
          projectId: body.projectId,
          suiteId: body.suiteId,
          repoFullName: body.repo,
          outagePolicy: body.outagePolicy,
          ...(installationRef !== undefined ? { installationRef } : {}),
          ...(repositoryId !== undefined ? { repositoryId } : {}),
        } as any,
      );
    } catch (error) {
      throw translateConvexWriteError(error, writeErrorOptions);
    }

    return v1Resource(
      c,
      {
        id: String(result?.configId ?? ""),
        organizationId,
        projectId: body.projectId,
        suiteId: body.suiteId,
        repo: body.repo,
        outagePolicy: body.outagePolicy,
      },
      201,
    );
  },
);

export default evalChecks;
