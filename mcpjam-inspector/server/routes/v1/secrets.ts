/**
 * Public v1 SECRETS surface — write-only, without exception.
 *
 * A project secret is a named credential a real workflow needs: `STRIPE_API_KEY`
 * for a `stripe` CLI run, `GH_TOKEN` for `gh`, a password for `psql`. Before
 * this, the only way to get one into a run was hand-editing a server's `env` in
 * the UI: per-server, invisible to the API, unusable from CI. The Sessions API
 * shipped and still could not be handed a credential, which made automation
 * half a product.
 *
 * ## Write-only means write-only
 *
 * No route here returns a value, and none can. The DTO below has no `value`
 * field; the Convex functions behind these routes have no code path that
 * produces one; the only two things that decrypt are the delivery paths, which
 * write into a sandbox's environment or an egress policy and return nothing to
 * a caller. A test asserts this on the RESPONSE SCHEMA rather than on a sample
 * body, because a sample body only proves what one fixture happened not to
 * contain.
 *
 * ## Two delivery modes, and the honest description of each
 *
 *   - `brokered` (the default) — the value is injected as a request header by
 *     the sandbox's egress proxy, OUTSIDE the VM. The box never holds it, so a
 *     prompt-injected agent has nothing to exfiltrate. It prevents EXTRACTION,
 *     not USE: any process in the box can call the bound host while the policy
 *     is live. Works for HTTPS APIs only — the proxy binds domain rules on
 *     ports 80/443.
 *   - `materialized` — a real environment variable inside the box, because a
 *     CLI cannot read a header the proxy adds. EXTRACTABLE BY DESIGN: `env`
 *     prints it. The label, the transcript scrubber and the brokered default
 *     are mitigations, not a claim that it is safe.
 *
 * ## Two sharing scopes
 *
 *   - `project` — admin-managed, delivered to every member's sessions.
 *   - `user` — personal; delivered ONLY in sessions its owner starts, and
 *     silently absent from another member's run of the same environment. That
 *     silence is documented behaviour, not a bug: an error would leak that the
 *     secret exists, and the environment's other secrets should still deliver.
 *
 * ## Cross-project scoping is enforced in CONVEX, not here
 *
 * `personas.ts`'s header apologizes for a list-and-scan preflight and names the
 * fix: a scoped getter taking `{projectId, resourceId}` that asserts the scope
 * inside Convex, where a scope rule belongs. `projectSecrets:getSecret` is that
 * getter, built up front — so every by-id route below is one read with one
 * decision, and there is no copy of the rule in this file to drift.
 *
 * ## Guests
 *
 * `guest-allowed-paths.ts` is default-deny and there is deliberately NO entry
 * for `/secrets`. Nothing here is reachable by an unauthenticated caller, and
 * adding an entry would be the single change that breaks that.
 */
import { Hono } from "hono";
import { z } from "zod";
import { createConvexClient } from "./convex-client.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";

const secrets = new Hono();

function translateReadError(error: unknown): WebRouteError {
  return translateConvexReadError(error, { scope: "v1.secrets" });
}

/**
 * Convex `projectSecrets:toSecretView` output, hand-mirrored.
 *
 * Note what is NOT here, and could not be added by accident: a value. The
 * backend view type has no such field, so a `value` on this type would fail to
 * compile against nothing — which is why the contract test asserts on the
 * response SCHEMA instead of trusting the mirror.
 */
type SecretRow = {
  secretId: string;
  projectId: string;
  name: string;
  description?: string;
  delivery: "brokered" | "materialized";
  brokerHosts?: string[];
  brokerHeader?: string;
  brokerTemplate?: string;
  sharing: "user" | "project";
  ownerUserId?: string;
  isOwner: boolean;
  lastDeliveredAt?: number;
  createdAt: number;
  updatedAt: number;
  createdByUserId: string;
  updatedByUserId: string;
};

function toSecretDto(row: SecretRow) {
  return {
    id: row.secretId,
    projectId: row.projectId,
    /** The environment-variable name. This IS the secret's identity. */
    name: row.name,
    description: row.description ?? null,
    delivery: row.delivery,
    ...(row.brokerHosts !== undefined ? { brokerHosts: row.brokerHosts } : {}),
    ...(row.brokerHeader !== undefined
      ? { brokerHeader: row.brokerHeader }
      : {}),
    ...(row.brokerTemplate !== undefined
      ? { brokerTemplate: row.brokerTemplate }
      : {}),
    sharing: row.sharing,
    /** Personal secrets only. Absent on project-shared rows, which have no owner. */
    ...(row.ownerUserId !== undefined ? { ownerUserId: row.ownerUserId } : {}),
    /**
     * When this secret was last HANDED TO a run — not when it was last used.
     * Brokered use is unobservable to us by construction (the proxy injects the
     * header and we never see the request), so "used" would be a number we
     * cannot honestly produce. `null` means nothing has been recorded, which is
     * not the same as "never delivered".
     */
    lastDeliveredAt: row.lastDeliveredAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
  };
}

const NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    NAME_PATTERN,
    "Secret name must be an environment-variable identifier: uppercase letters, digits and underscores, not starting with a digit (e.g. STRIPE_API_KEY).",
  );

/**
 * The secret itself.
 *
 * NOT trimmed, deliberately, and the schema must not add `.trim()`: a trailing
 * newline is meaningful in some credentials (a PEM block), and silently
 * rewriting what the caller sent produces a failure that presents as "the API
 * key is wrong" with nothing to look at.
 */
const valueSchema = z
  .string()
  .min(1)
  .max(64 * 1024);

const brokerHostsSchema = z
  .array(z.string().trim().min(1).max(253))
  .min(1)
  .max(10);
const brokerHeaderSchema = z.string().trim().min(1).max(64);
const brokerTemplateSchema = z.string().min(1).max(256);

const deliverySchema = z.enum(["brokered", "materialized"]);
const sharingSchema = z.enum(["user", "project"]);

/**
 * The broker triple is required IFF `delivery === "brokered"`, checked in both
 * directions.
 *
 * A brokered row missing it would be delivered as nothing, silently. A
 * materialized row CARRYING it would tell every reader the value is
 * proxy-injected when it is in fact an environment variable in the box — the
 * exact confusion the two modes exist to keep apart. The backend enforces the
 * same rule; this refine exists so the caller learns it at the boundary with a
 * message naming the fields, rather than as a Convex error.
 */
function refineBrokerBinding<
  T extends {
    delivery?: "brokered" | "materialized";
    brokerHosts?: string[];
    brokerHeader?: string;
    brokerTemplate?: string;
  },
>(value: T): boolean {
  const supplied =
    value.brokerHosts !== undefined ||
    value.brokerHeader !== undefined ||
    value.brokerTemplate !== undefined;
  if (value.delivery === "materialized") return !supplied;
  if (value.delivery === "brokered") {
    return (
      value.brokerHosts !== undefined &&
      value.brokerHeader !== undefined &&
      value.brokerTemplate !== undefined
    );
  }
  // `delivery` omitted on PATCH: the binding may be edited in place, and the
  // backend re-validates against the row's stored mode.
  return true;
}

const BROKER_BINDING_MESSAGE =
  'A brokered secret must declare `brokerHosts`, `brokerHeader` and `brokerTemplate` (e.g. ["api.stripe.com"], "Authorization", "Bearer {}"); a materialized secret must declare none of them.';

const createSecretSchema = z
  .strictObject({
    name: nameSchema,
    value: valueSchema,
    description: z.string().max(500).optional(),
    /**
     * REQUIRED, with no default. `brokered` is the safer mode and the one the
     * UI defaults to, but a caller who does not say which they want is a caller
     * who has not thought about whether the value ends up inside the box — and
     * defaulting silently would make that decision for them.
     */
    delivery: deliverySchema,
    brokerHosts: brokerHostsSchema.optional(),
    brokerHeader: brokerHeaderSchema.optional(),
    brokerTemplate: brokerTemplateSchema.optional(),
    /**
     * Defaults to `project`: a secret a team creates is normally a team secret,
     * and the surprising outcome is a credential nobody else's session can use.
     * A non-admin asking for `project` is REFUSED rather than downgraded to
     * personal — a silent downgrade looks like success and then is not
     * delivered to anyone but them.
     */
    sharing: sharingSchema.optional(),
  })
  .refine(refineBrokerBinding, { message: BROKER_BINDING_MESSAGE });

/**
 * PATCH rotates the value and/or edits the binding.
 *
 * `name` and `sharing` are IMMUTABLE in v1, and their absence here is the
 * contract rather than an oversight. Renaming would break the running workflows
 * that reference the environment variable; re-sharing would change who has been
 * handed the value without changing the value. Both are "delete and recreate",
 * which keeps env-var identity and grant history honest.
 */
const updateSecretSchema = z
  .strictObject({
    value: valueSchema.optional(),
    description: z.string().max(500).nullable().optional(),
    delivery: deliverySchema.optional(),
    brokerHosts: brokerHostsSchema.optional(),
    brokerHeader: brokerHeaderSchema.optional(),
    brokerTemplate: brokerTemplateSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message:
      "Provide at least one of `value`, `description`, `delivery`, `brokerHosts`, `brokerHeader`, or `brokerTemplate` to update.",
  })
  .refine(refineBrokerBinding, { message: BROKER_BINDING_MESSAGE });

async function parseBody<T>(
  c: { req: { json: () => Promise<unknown> } },
  schema: z.ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be JSON",
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? "Invalid request body",
    );
  }
  return parsed.data;
}

/**
 * The write idempotency key, straight from the header with NO transformation.
 *
 * Load-bearing for the same reason it is on personas: Convex fingerprints a
 * replay from the request, so a layer that injected or renamed a field would
 * make the retry arrive with a different fingerprint and be rejected as key
 * reuse. Every optional field below is forwarded only when the caller sent it.
 *
 * The secrets fingerprint additionally PRE-HASHES the value backend-side, so
 * the stored fingerprint is a hash of a hash — a leaked metadata row cannot
 * seed an offline guess against a low-entropy secret.
 */
function idempotencyKeyOf(c: {
  req: { header: (name: string) => string | undefined };
}): string | undefined {
  const key = c.req.header("idempotency-key")?.trim();
  return key && key.length > 0 ? key : undefined;
}

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /v1/projects/:projectId/secrets — metadata only.
//
// Returns project-shared secrets plus the CALLER'S OWN personal ones. Another
// member's personal secret is absent entirely — not redacted, not listed with a
// hidden value; its name never appears.
secrets.get("/projects/:projectId/secrets", async (c) => {
  const projectId = c.req.param("projectId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  let rows: SecretRow[];
  try {
    rows = ((await client.query(
      "projectSecrets:listSecrets" as never,
      {
        projectId,
      } as never,
    )) ?? []) as SecretRow[];
  } catch (error) {
    throw translateReadError(error);
  }
  return v1PageJson(c, rows.map(toSecretDto));
});

// GET /v1/projects/:projectId/secrets/:secretId — metadata only.
//
// The scoped getter does the cross-project check inside Convex, so a valid id
// from another project reads as NOT_FOUND. So does another member's personal
// secret — a 403 there would confirm the id names a real row.
secrets.get("/projects/:projectId/secrets/:secretId", async (c) => {
  const projectId = c.req.param("projectId");
  const secretId = c.req.param("secretId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  let row: SecretRow;
  try {
    row = (await client.query(
      "projectSecrets:getSecret" as never,
      {
        projectId,
        secretId,
      } as never,
    )) as SecretRow;
  } catch (error) {
    throw translateReadError(error);
  }
  return v1Resource(c, toSecretDto(row));
});

// POST /v1/projects/:projectId/secrets
//
// The value crosses exactly one boundary: this request, and then client →
// Convex Node action. It is never logged, never echoed, and never returned —
// the 201 body is the same metadata DTO every read produces.
//
// IDEMPOTENT on `idempotency-key`. Worth using: a retried create without one
// fails as a name conflict with the row the first attempt already made, which
// is indistinguishable from a genuine collision.
secrets.post("/projects/:projectId/secrets", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await parseBody(c, createSecretSchema);
  const client = createConvexClient(await getConvexBearerForRequest(c));
  const idempotencyKey = idempotencyKeyOf(c);

  let row: SecretRow;
  try {
    // An ACTION, not a mutation: encryption is Node-only in Convex, and this is
    // the one hop a plaintext makes.
    row = (await client.action(
      "projectSecretsNode:createSecret" as never,
      {
        projectId,
        name: body.name,
        value: body.value,
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        delivery: body.delivery,
        ...(body.brokerHosts !== undefined
          ? { brokerHosts: body.brokerHosts }
          : {}),
        ...(body.brokerHeader !== undefined
          ? { brokerHeader: body.brokerHeader }
          : {}),
        ...(body.brokerTemplate !== undefined
          ? { brokerTemplate: body.brokerTemplate }
          : {}),
        ...(body.sharing !== undefined ? { sharing: body.sharing } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      } as never,
    )) as SecretRow;
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Secret" });
  }

  return v1Resource(c, toSecretDto(row), 201);
});

// PATCH /v1/projects/:projectId/secrets/:secretId
//
// ROTATION SEMANTICS, and they are not hidden: a rotated value reaches NEW RUNS
// ONLY. A session already running holds the old value — materialized in its
// box's environment, or inside an egress transform we cannot read back — and
// there is no safe way to reach in and replace it mid-run. Same rule Devin
// documents as "sessions created after you added the secret".
secrets.patch("/projects/:projectId/secrets/:secretId", async (c) => {
  const projectId = c.req.param("projectId");
  const secretId = c.req.param("secretId");
  const body = await parseBody(c, updateSecretSchema);
  const client = createConvexClient(await getConvexBearerForRequest(c));

  let row: SecretRow;
  try {
    row = (await client.action(
      "projectSecretsNode:updateSecret" as never,
      {
        projectId,
        secretId,
        ...(body.value !== undefined ? { value: body.value } : {}),
        // Tri-state: `null` clears the description, a value replaces it, omission
        // leaves it. Forwarded with `!== undefined` so the two do not collapse.
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.delivery !== undefined ? { delivery: body.delivery } : {}),
        ...(body.brokerHosts !== undefined
          ? { brokerHosts: body.brokerHosts }
          : {}),
        ...(body.brokerHeader !== undefined
          ? { brokerHeader: body.brokerHeader }
          : {}),
        ...(body.brokerTemplate !== undefined
          ? { brokerTemplate: body.brokerTemplate }
          : {}),
      } as never,
    )) as SecretRow;
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Secret" });
  }

  return v1Resource(c, toSecretDto(row));
});

// DELETE /v1/projects/:projectId/secrets/:secretId
//
// A HARD delete: the row goes and the ciphertext behind it goes with it. This
// is the revoke button, so it must not be soft.
//
// Deliberately NOT blocked when an environment still selects the secret. The
// selection resolver drops ids that no longer resolve, and refusing here would
// make a leaked credential un-revokable until someone edited every environment
// referencing it. Revocation is never gated on cleanup.
secrets.delete("/projects/:projectId/secrets/:secretId", async (c) => {
  const projectId = c.req.param("projectId");
  const secretId = c.req.param("secretId");
  const client = createConvexClient(await getConvexBearerForRequest(c));

  let result: { deleted: true; secretId: string; name: string };
  try {
    result = (await client.action(
      "projectSecretsNode:deleteSecret" as never,
      {
        projectId,
        secretId,
      } as never,
    )) as { deleted: true; secretId: string; name: string };
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Secret" });
  }

  return v1Resource(c, {
    id: result.secretId,
    projectId,
    name: result.name,
    deleted: true,
  });
});

export default secrets;
