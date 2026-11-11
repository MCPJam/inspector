/**
 * Public v1 server accounts: the accounts a saved server signs in with,
 * addressed by id or by name.
 *
 * Tokens are write-only. `PUT` uploads them and no route returns one: every
 * answer is the account view, projected in `server-account-backend.ts`. An
 * account `PUT` writes is hosted-only, so hosted runs use it and nothing hands
 * its token to a local app, a browser or a sandbox.
 *
 * An upload never connects to the MCP server, so nothing checks who a token
 * belongs to: a name is the caller's own label, and replacing a token
 * replaces it whoever it belongs to.
 *
 * References resolve in the backend, inside the write's own mutation, so two
 * concurrent uploads under a new name end with one account. A reference that
 * is a well-formed account id is an id; anything else is a name.
 *
 * No guest path: `guest-allowed-paths.ts` is default-deny and has no entry
 * for `/accounts`.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { ErrorCode, parseWithSchema, WebRouteError } from "../web/errors.js";
import { readJsonObjectBody } from "./adapter.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import {
  accountAnswer,
  accountListAnswer,
  accountScope,
  callAccountsBackend,
  deleteAnswer,
  uploadAnswer,
  type AccountView,
} from "./server-account-backend.js";

const serverAccounts = new Hono();

const ACCOUNTS = "/projects/:projectId/servers/:serverId/accounts";
const ACCOUNT = `${ACCOUNTS}/:account`;

const MAX_TOKEN_BYTES = 16 * 1024;

const tokenString = z
  .string()
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_TOKEN_BYTES, {
    params: { code: "token_too_large" },
  });

/** An upload's token fields; `PUT` holds them strictly, the alias leniently. */
export const tokenFields = {
  access_token: tokenString.min(1),
  refresh_token: tokenString.optional(),
  expires_in: z.number().nonnegative().optional(),
  token_type: tokenString.optional(),
  scope: tokenString.optional(),
};

export const clientFields = {
  clientId: z.string().min(1).max(MAX_TOKEN_BYTES),
  clientSecret: z.string().min(1).max(MAX_TOKEN_BYTES).optional(),
};

const uploadSchema = z.strictObject({
  tokens: z.strictObject(tokenFields),
  clientInformation: z.strictObject(clientFields),
});

const updateSchema = z
  .strictObject({
    name: z.string().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((body) => body.name !== undefined || body.isDefault !== undefined, {
    message: "Send name, isDefault: true, or both.",
  });

type Issue = z.ZodError["issues"][number];

/** A refused upload field, with the contract's code where it has one. */
function uploadRefusal(issue: Issue | undefined): WebRouteError {
  const field = (key?: PropertyKey) =>
    [...(issue?.path ?? []), ...(key === undefined ? [] : [key])]
      .map(String)
      .join(".");
  if (issue?.code === "unrecognized_keys") {
    const refused = issue.keys.find(
      (key) => key === "id_token" || /url$/i.test(key),
    );
    if (!refused) {
      return new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `${field(issue.keys[0])} is not a field this endpoint accepts. Remove it and try again.`,
      );
    }
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      refused === "id_token"
        ? `${field(refused)} is not accepted. Upload the access token without an ID token.`
        : `${field(refused)} is not accepted, because uploaded tokens are used with the server URL saved in the project. Remove it and try again.`,
      { code: "field_not_accepted" },
    );
  }
  if (issue?.code === "custom" && issue.params?.code === "token_too_large") {
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `${field()} is over 16 KB, the largest token an account stores. Upload a smaller token.`,
      { code: "token_too_large" },
    );
  }
  return new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    issue
      ? `${field() ? `${field()}: ` : ""}${issue.message}`
      : "The upload body is not valid. Send tokens and clientInformation.",
  );
}

/** Parse an upload body with this route's refusals, for `PUT` and the alias. */
export function parseUpload<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw uploadRefusal(parsed.error.issues[0]);
  return parsed.data;
}

export type AccountUpload = {
  account: { ref: string } | { default: true };
  /**
   * `always` for `PUT`. The alias sends `whenCreated`: an account it creates
   * is hosted-only, and an existing default it writes into keeps its rule.
   */
  hostedOnly: "always" | "whenCreated";
  /** The alias only: the backend refuses one that is not the saved URL. */
  serverUrl?: string;
  clientInformation: { clientId: string; clientSecret?: string };
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
};

/** The one upload path, for `PUT` and the alias. */
export function uploadAccountTokens(c: Context, upload: AccountUpload) {
  return callAccountsBackend(
    c,
    "/web/oauth/import-tokens",
    {
      ...accountScope(c),
      kind: "generic",
      account: upload.account,
      hostedOnly: upload.hostedOnly,
      source: "api",
      ...(upload.serverUrl !== undefined
        ? { serverUrl: upload.serverUrl }
        : {}),
      clientInformation: upload.clientInformation,
      tokens: upload.tokens,
    },
    uploadAnswer,
  );
}

function accountRef(c: Context): { ref: string } {
  return { ref: c.req.param("account") ?? "" };
}

serverAccounts.get(ACCOUNTS, async (c) => {
  const { accounts } = await callAccountsBackend(
    c,
    "/web/oauth/connections",
    { ...accountScope(c), view: "api" },
    accountListAnswer,
  );
  return v1PageJson(c, accounts);
});

serverAccounts.get(ACCOUNT, async (c) => {
  const { account } = await callAccountsBackend(
    c,
    "/web/oauth/connections/get",
    { ...accountScope(c), account: accountRef(c), view: "api" },
    accountAnswer,
  );
  return v1Resource(c, account);
});

// PUT creates the account (201) or replaces its token in place (200).
serverAccounts.put(ACCOUNT, async (c) => {
  const body = parseUpload(uploadSchema, await readJsonObjectBody(c));
  const { created, account } = await uploadAccountTokens(c, {
    ...body,
    account: accountRef(c),
    hostedOnly: "always",
  });
  return v1Resource(c, account, created ? 201 : 200);
});

serverAccounts.patch(ACCOUNT, async (c) => {
  const body = parseWithSchema(updateSchema, await readJsonObjectBody(c));
  if (body.isDefault === false) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "isDefault can't be false. To change the default, set isDefault: true on another account.",
    );
  }
  let account: AccountView | undefined;
  if (body.name !== undefined) {
    ({ account } = await callAccountsBackend(
      c,
      "/web/oauth/connections/label",
      {
        ...accountScope(c),
        account: accountRef(c),
        label: body.name,
        nameRules: "api",
        view: "api",
      },
      accountAnswer,
    ));
  }
  if (body.isDefault) {
    // By id after a rename: the name the caller addressed no longer matches.
    ({ account } = await callAccountsBackend(
      c,
      "/web/oauth/connections/default",
      {
        ...accountScope(c),
        account: account ? { ref: account.id } : accountRef(c),
        view: "api",
      },
      accountAnswer,
    ));
  }
  return v1Resource(c, account);
});

// Deleting asks the issuer to revoke the token where it supports that, and
// the default is refused while other accounts exist, so a delete never
// changes which account runs use.
serverAccounts.delete(ACCOUNT, async (c) => {
  if (Object.keys(await readJsonObjectBody(c)).length > 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Send DELETE without a body.",
    );
  }
  await callAccountsBackend(
    c,
    "/web/oauth/connections/delete",
    { ...accountScope(c), account: accountRef(c), refuseIfDefault: true },
    deleteAnswer,
  );
  return v1Resource(c, { account: accountRef(c).ref, deleted: true });
});

export default serverAccounts;
