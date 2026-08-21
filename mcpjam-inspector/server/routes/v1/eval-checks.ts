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

const evalChecks = new Hono();

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
        } as any,
      );
    } catch (error) {
      throw translateConvexWriteError(error, {
        resource: "GitHub Checks repository",
        // The backend words these refusals deliberately — "install the App on
        // that repository" is different advice from "try again" — and it words
        // them the same for a repository that does not exist as for one the
        // App cannot see, on purpose: answering differently would turn this
        // into an oracle for private repository names.
        notFoundMessage:
          "Repository, project or suite not found, or the MCPJam GitHub App cannot reach it.",
        fallbackMessage: "GitHub Checks connection rejected by the platform",
        adminFailureIsForbidden: false,
      });
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
