/**
 * Producer credentials and the ingest switch for a project (PT-1), for its
 * admins:
 *
 *   GET    /v1/projects/:projectId/production/credentials
 *   POST   /v1/projects/:projectId/production/credentials
 *   POST   /v1/projects/:projectId/production/credentials/:credentialId/rotate
 *   DELETE /v1/projects/:projectId/production/credentials/:credentialId
 *   PUT    /v1/projects/:projectId/production/ingest
 *
 * Each call runs the backend's `productionIngestCredentials` function with
 * the caller's own bearer, so Convex decides who is an admin and holds the
 * rollout flag. A new or rotated credential's token is in that response
 * only; it is never logged or stored here.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { createConvexClient } from "./convex-client.js";
import { translateConvexWriteError } from "./convex-errors.js";
import {
  requireConvexIdShape,
  requireProjectIdArg,
} from "./convex-id-param.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import { v1Resource } from "./envelope.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";

const SCOPE = "v1.production-traffic-admin";
const RESOURCE = "Producer credential";

type CredentialList = {
  ingestEnabledAt: number | null;
  credentials: { credentialId: string }[];
};
type IssuedCredential = {
  credentialId: string;
  token: string;
  displayPrefix: string;
};

const issueSchema = z.object({
  label: z.string().min(1).max(80),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
const rotateSchema = z.object({
  overlapMinutes: z.number().int().min(0).max(10_080).optional(),
});
const ingestSchema = z.object({ enabled: z.boolean() });

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Send a JSON request body.",
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? "Check the request body.",
    );
  }
  return parsed.data;
}

async function convexFor(c: Context) {
  return createConvexClient(await getConvexBearerForRequest(c));
}

async function listCredentials(
  c: Context,
  projectId: string,
): Promise<CredentialList> {
  try {
    return (await (
      await convexFor(c)
    ).query(
      "productionIngestCredentials:listForProject" as never,
      { projectId } as never,
    )) as CredentialList;
  } catch (error) {
    throw translateConvexReadError(error, {
      scope: SCOPE,
      notFoundMessage: "Project not found",
      redactedIsRefusal: true,
    });
  }
}

/** The credential named in the path, refused unless it is this project's. */
async function credentialOf(c: Context, projectId: string): Promise<string> {
  const credentialId = requireConvexIdShape(
    c.req.param("credentialId"),
    "credentialId",
    { scope: SCOPE, notFoundMessage: `${RESOURCE} not found` },
  );
  const { credentials } = await listCredentials(c, projectId);
  if (!credentials.some((row) => row.credentialId === credentialId)) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, `${RESOURCE} not found`);
  }
  return credentialId;
}

function issued(c: Context, projectId: string, credential: IssuedCredential) {
  c.header("Cache-Control", "no-store");
  return v1Resource(
    c,
    {
      ...credential,
      endpoint: `/api/v1/projects/${projectId}/otlp/v1/traces`,
    },
    201,
  );
}

const admin = new Hono();

admin.get("/projects/:projectId/production/credentials", async (c) => {
  const projectId = requireProjectIdArg(c.req.param("projectId"), SCOPE);
  return v1Resource(c, { projectId, ...(await listCredentials(c, projectId)) });
});

admin.post("/projects/:projectId/production/credentials", async (c) => {
  const projectId = requireProjectIdArg(c.req.param("projectId"), SCOPE);
  const input = await body(c, issueSchema);
  let credential: IssuedCredential;
  try {
    credential = (await (
      await convexFor(c)
    ).action(
      "productionIngestCredentials:issue" as never,
      { projectId, ...input } as never,
    )) as IssuedCredential;
  } catch (error) {
    throw translateConvexWriteError(error, { resource: RESOURCE });
  }
  return issued(c, projectId, credential);
});

admin.post(
  "/projects/:projectId/production/credentials/:credentialId/rotate",
  async (c) => {
    const projectId = requireProjectIdArg(c.req.param("projectId"), SCOPE);
    const credentialId = await credentialOf(c, projectId);
    const input = await body(c, rotateSchema);
    let credential: IssuedCredential;
    try {
      credential = (await (
        await convexFor(c)
      ).action(
        "productionIngestCredentials:rotate" as never,
        { credentialId, ...input } as never,
      )) as IssuedCredential;
    } catch (error) {
      throw translateConvexWriteError(error, { resource: RESOURCE });
    }
    return issued(c, projectId, credential);
  },
);

admin.delete(
  "/projects/:projectId/production/credentials/:credentialId",
  async (c) => {
    const projectId = requireProjectIdArg(c.req.param("projectId"), SCOPE);
    const credentialId = await credentialOf(c, projectId);
    let result: { revokedAt: number };
    try {
      result = (await (
        await convexFor(c)
      ).mutation(
        "productionIngestCredentials:revoke" as never,
        { credentialId } as never,
      )) as { revokedAt: number };
    } catch (error) {
      throw translateConvexWriteError(error, { resource: RESOURCE });
    }
    return v1Resource(c, { credentialId, revokedAt: result.revokedAt });
  },
);

admin.put("/projects/:projectId/production/ingest", async (c) => {
  const projectId = requireProjectIdArg(c.req.param("projectId"), SCOPE);
  const { enabled } = await body(c, ingestSchema);
  let result: { enabledAt: number | null };
  try {
    result = (await (
      await convexFor(c)
    ).mutation(
      "productionIngestCredentials:setIngestEnabled" as never,
      { projectId, enabled } as never,
    )) as { enabledAt: number | null };
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Production traffic" });
  }
  return v1Resource(c, { projectId, enabledAt: result.enabledAt });
});

export default admin;
