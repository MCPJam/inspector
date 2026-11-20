/**
 * `POST /v1/projects/:projectId/variant-servers`: create a server variant, in
 * beta behind `variant-servers-enabled`, which the backend enforces.
 *
 * The base is read live with the caller's own authorization: every
 * `tools/list` page, each Tool exactly as the server sent it. The edits are
 * checked against that read and hashed, and the backend stores the variant,
 * answering the existing one when the base, its tools and the edits match.
 */
import { Hono, type Context } from "hono";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";
import {
  VARIANT_LIMITS, VariantError, buildVariantDraft, pinVariantSurface,
  variantErrorMessages, type VariantDraft, type VariantTool,
} from "@mcpjam/sdk/variants";
import { HOSTED_MODE, WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import {
  isLocalRouteFailure, markLocalRouteFailure, projectHostedV1Failure,
} from "../../utils/hosted-route-failure.js";
import { readLaunchContext } from "../../utils/launch-context.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  managerVariant, unsupportedVariantBase, variantDefinitionSchema, variantRouteError,
} from "../../utils/variant-servers.js";
import { parseWithSchema, projectServerSchema, runEphemeralConnection } from "../web/auth.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { createHostedRpcLogCollector } from "../web/hosted-rpc-logs.js";
import { readJsonObjectBody } from "./adapter.js";
import { createConvexClient } from "./convex-client.js";
import {
  convexErrorData, translateConvexWriteError, translateStructuredConvexRefusal,
} from "./convex-errors.js";
import { looksLikeConvexId } from "./convex-id-param.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import { v1OnError, v1Resource } from "./envelope.js";

const createVariantServerBody = z.strictObject({
  server: z.string().trim().min(1),
  // Checked against the base's tools, which answers with the contract's codes.
  edits: z
    .array(z.object({ feature: z.string(), target: z.string(), op: z.string(), value: z.unknown() }))
    .min(1, "A variant needs at least one edit. Add one to edits."),
  label: z.string().trim().min(1).optional(),
});

const rawToolsPage = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })),
  nextCursor: z.string().optional(),
});

type ServerRow = { _id: string; name?: string; transportType?: string };
const projectServersRef = makeFunctionReference<"query", { projectId: string }, ServerRow[]>(
  "servers:getProjectServers",
);

type StoreVariantArgs = Pick<VariantDraft, "edits" | "baseSurfaceHash" | "toolHashes"> & {
  projectId: string;
  baseServerId: string;
  label?: string;
  createdVia: "mcp" | "cli" | "rest";
};

// The backend's create, the one call that stores a variant. It recomputes
// `editsHash` and `contentHash` itself.
const createVariantServerRef = makeFunctionReference<"mutation", StoreVariantArgs, unknown>(
  "serverVariants:createVariantServer",
);
const storedVariantSchema = variantDefinitionSchema.extend({
  label: z.string().optional(),
  created: z.boolean(),
});

async function storeVariantServer(token: string, args: StoreVariantArgs) {
  let answer: unknown;
  try {
    answer = await createConvexClient(token).mutation(createVariantServerRef, args);
  } catch (error) {
    // Every refusal keeps the backend's code and sentence, a not-found's too.
    const data = convexErrorData(error);
    const message = data?.code === "NOT_FOUND" ? data.message : undefined;
    throw translateConvexWriteError(error, {
      resource: "Variant server",
      ...(typeof message === "string" && message.trim() ? { notFoundMessage: message } : {}),
    });
  }
  const stored = storedVariantSchema.safeParse(answer);
  if (stored.success) return stored.data;
  throw new WebRouteError(500, ErrorCode.INTERNAL_ERROR,
    "The variant was saved, but its record couldn't be read. Create it again to get its server ID.");
}

/** The saved server `selector` names: an id, or a name unique in the project. */
async function resolveBase(token: string, projectId: string, selector: string) {
  let rows: ServerRow[];
  try {
    rows = await createConvexClient(token).query(projectServersRef, { projectId });
  } catch (error) {
    throw translateStructuredConvexRefusal(error) ?? translateConvexReadError(error, {
      scope: "v1.variant-servers", notFoundMessage: "Project not found", redactedIsRefusal: true,
    });
  }
  const byId = rows.find((row) => row._id === selector);
  const wanted = selector.toLocaleLowerCase();
  const named = byId ? [] : rows.filter((row) => row.name?.toLocaleLowerCase() === wanted);
  if (named.length > 1) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR,
      `More than one server in this project is named "${selector}". Use its server ID.`);
  }
  const match = byId ?? named[0];
  // A variant is left out of the listing, so an unlisted id goes on to
  // authorization, which says whether it is one.
  if (!match && looksLikeConvexId(selector)) return { id: selector, name: selector };
  if (!match) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND,
      `This project has no server named "${selector}". Check the name with list_project_servers.`);
  }
  if (match.transportType !== "http") throw unsupportedVariantBase();
  return { id: match._id, name: match.name ?? selector };
}

/**
 * Every `tools/list` page of the base, read with the caller's authorization.
 * Hosted, a connection failure is answered as the other live routes answer it.
 */
async function pinBase(c: Context, projectId: string, base: { id: string; name: string }) {
  const collector = HOSTED_MODE ? createHostedRpcLogCollector(null) : undefined;
  const pin = async (manager: Parameters<Parameters<typeof runEphemeralConnection>[3]>[0]) => {
    if (managerVariant(manager, base.id)) throw markLocalRouteFailure(unsupportedVariantBase());
    // The manager started connecting when it was built; this waits for it.
    const config = manager.getServerConfig(base.id);
    const client = manager.getManagedClient(base.id) ??
      (config ? await manager.connectToServer(base.id, config) : undefined);
    if (!client) {
      throw new WebRouteError(502, ErrorCode.SERVER_UNREACHABLE,
        `Couldn't connect to "${base.name}". Check it with diagnose_server, then try again.`);
    }
    let listFailed = false;
    const listPage = (cursor?: string) =>
      client.requestWithSchema(
        { method: "tools/list", params: cursor === undefined ? {} : { cursor } }, rawToolsPage,
      ).catch((error: unknown) => {
        listFailed = true;
        throw error;
      });
    try {
      return (await pinVariantSurface({ listPage })).tools;
    } catch (error) {
      // Every page answered, so this is the page cap: the base's answer.
      if (listFailed || !(error instanceof Error)) throw error;
      throw markLocalRouteFailure(new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message));
    }
  };
  try {
    return await runEphemeralConnection(c, { projectId, serverId: base.id }, projectServerSchema, pin, {
      timeoutMs: WEB_CONNECT_TIMEOUT_MS,
      rpcLogger: collector?.rpcLogger,
      httpLogger: collector?.httpLogger,
    });
  } catch (error) {
    if (!collector || isLocalRouteFailure(error)) throw error;
    return v1OnError(error, c, projectHostedV1Failure(error, { ...collector.buildEnvelope() }));
  }
}

const variantServers = new Hono();

variantServers.post("/projects/:projectId/variant-servers", async (c) => {
  const projectId = c.req.param("projectId");
  const body = parseWithSchema(createVariantServerBody, await readJsonObjectBody(c));
  if (body.edits.length > VARIANT_LIMITS.maxEdits) {
    throw variantRouteError(new VariantError("VARIANT_TOO_LARGE", variantErrorMessages.VARIANT_TOO_LARGE()));
  }
  const token = await getConvexBearerForRequest(c);
  const base = await resolveBase(token, projectId, body.server);
  const pinned: VariantTool[] | Response = await pinBase(c, projectId, base);
  if (pinned instanceof Response) return pinned;

  let draft: VariantDraft;
  try {
    draft = await buildVariantDraft({ baseServerId: base.id, tools: pinned, edits: body.edits, serverName: base.name });
  } catch (error) {
    throw error instanceof VariantError ? variantRouteError(error) : error;
  }
  // A label the caller declared, like a run's launcher: never authorization.
  const launcher = readLaunchContext(c)?.launcher?.kind;
  const { edits, baseSurfaceHash, toolHashes, diff } = draft;
  const variant = await storeVariantServer(token, {
    projectId,
    baseServerId: base.id,
    edits,
    baseSurfaceHash,
    toolHashes,
    ...(body.label ? { label: body.label } : {}),
    createdVia: launcher === "mcp" || launcher === "cli" ? launcher : "rest",
  });
  return v1Resource(c, { variant, diff });
});

export default variantServers;
