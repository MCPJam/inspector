/**
 * The server account operations: the accounts a saved server signs in with,
 * addressed by id or by name. Tokens are write-only: an upload takes them,
 * and no operation returns one.
 */
import { z } from "zod";
import type { PlatformOperation } from "./operations.js";
import {
  resolveServerScope,
  serverPermalink,
  serverScopedInput,
  type ServerResult,
  type ServerScopedInput,
} from "./operation-support.js";
import { derivePermalinks, noPermalink } from "./permalinks.js";
import type {
  PlatformServerAccount,
  PlatformServerAccountDeleted,
} from "./server-account-types.js";

const accountInput = serverScopedInput.extend({
  account: z
    .string()
    .trim()
    .min(1)
    .describe("The account's id, or its name. An id is matched first."),
});

const uploadInput = accountInput.extend({
  tokens: z
    .object({
      access_token: z
        .string()
        .min(1)
        .describe(
          "The access token. It travels in this call; no operation returns it."
        ),
      refresh_token: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Omit it when you upload a fresh token before each run, or when the issuer rejects refreshes: stored, it only adds a long-lived credential."
        ),
      expires_in: z
        .number()
        .nonnegative()
        .optional()
        .describe("Seconds until the access token expires."),
      token_type: z.string().optional(),
      scope: z.string().optional(),
    })
    .strict(),
  clientInformation: z
    .object({
      clientId: z
        .string()
        .min(1)
        .describe("The OAuth client the token was issued to."),
      clientSecret: z.string().min(1).optional(),
    })
    .strict(),
});

const updateInput = accountInput
  .extend({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A new name: letters, digits, '.', '_' and '-', starting with a letter or digit, at most 64 characters. Unique on the server, ignoring case."
      ),
    isDefault: z
      .literal(true)
      .optional()
      .describe(
        "Make this the account runs use by default. To move the default away, set it on another account."
      ),
  })
  .refine((input) => input.name !== undefined || input.isDefault, {
    message: "Pass name, isDefault: true, or both.",
  });

export type ServerAccountInput = z.infer<typeof accountInput>;
export type UploadServerAccountTokensInput = z.infer<typeof uploadInput>;
export type UpdateServerAccountInput = z.infer<typeof updateInput>;

export type ListServerAccountsResult = ServerResult & {
  accounts: PlatformServerAccount[];
};
export type ServerAccountResult = ServerResult & {
  account: PlatformServerAccount;
};
export type UploadServerAccountTokensResult = ServerAccountResult & {
  created: boolean;
};
export type DeleteServerAccountResult = ServerResult &
  PlatformServerAccountDeleted;

export const listServerAccountsOperation: PlatformOperation<
  ServerScopedInput,
  ListServerAccountsResult
> = {
  name: "list_server_accounts",
  title: "List a server's accounts",
  description:
    "List the accounts a saved MCP server signs in with: each one's id, name, whether runs use it by default, whether it needs reconnecting, and whether it is for hosted runs only. Never a token. You see your own personal accounts, or the project accounts of a server shared with the project.",
  readOnly: true,
  permalink: derivePermalinks(serverPermalink),
  inputSchema: serverScopedInput,
  async execute(input, context) {
    const { client, scope, result } = await resolveServerScope(input, context);
    const page = await client.listServerAccounts(scope, {
      signal: context.signal,
    });
    return { ...result, accounts: page.items };
  },
};

export const getServerAccountOperation: PlatformOperation<
  ServerAccountInput,
  ServerAccountResult
> = {
  name: "get_server_account",
  title: "Get a server account",
  description:
    "Read one account of a saved MCP server by id or name. Never a token. Another person's personal account answers not found, the same as a missing one, and a name two accounts share answers a conflict listing both ids.",
  readOnly: true,
  permalink: derivePermalinks(serverPermalink),
  inputSchema: accountInput,
  async execute(input, context) {
    const { client, scope, result } = await resolveServerScope(input, context);
    const account = await client.getServerAccount(
      { ...scope, account: input.account },
      { signal: context.signal }
    );
    return { ...result, account };
  },
};

export const uploadServerAccountTokensOperation: PlatformOperation<
  UploadServerAccountTokensInput,
  UploadServerAccountTokensResult
> = {
  name: "upload_server_account_tokens",
  title: "Upload tokens to a server account",
  description:
    "Store an access token on a saved server's account, by id or name. A name no account has creates one (`created: true`); otherwise the token is replaced in place and the id stays. THE TOKEN TRAVELS IN THIS CALL, so read it from a file or an environment variable. Nothing checks who the token belongs to: the name is your own label, and a replacement replaces the token whoever it belongs to. The account is for hosted runs only: no local app, browser or sandbox receives its token.",
  readOnly: false,
  risk: "exposure",
  permalink: derivePermalinks(serverPermalink),
  inputSchema: uploadInput,
  async execute(input, context) {
    const { client, scope, result } = await resolveServerScope(input, context);
    const { account, created } = await client.uploadServerAccountTokens(
      {
        ...scope,
        account: input.account,
        body: {
          tokens: input.tokens,
          clientInformation: input.clientInformation,
        },
      },
      { signal: context.signal }
    );
    return { ...result, account, created };
  },
};

export const updateServerAccountOperation: PlatformOperation<
  UpdateServerAccountInput,
  ServerAccountResult
> = {
  name: "update_server_account",
  title: "Rename a server account or make it the default",
  description:
    "Rename one of a saved server's accounts, make it the default, or both. Runs with no saved account choice act as the default, so set it before you start a run, and don't start runs that need different defaults at the same time.",
  readOnly: false,
  risk: "exposure",
  permalink: derivePermalinks(serverPermalink),
  inputSchema: updateInput,
  async execute(input, context) {
    const { client, scope, result } = await resolveServerScope(input, context);
    const account = await client.updateServerAccount(
      {
        ...scope,
        account: input.account,
        body: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.isDefault ? { isDefault: true as const } : {}),
        },
      },
      { signal: context.signal }
    );
    return { ...result, account };
  },
};

export const deleteServerAccountOperation: PlatformOperation<
  ServerAccountInput,
  DeleteServerAccountResult
> = {
  name: "delete_server_account",
  title: "Delete a server account",
  description:
    "Delete one of a saved server's accounts by id or name, with its stored token. The token's issuer is asked to revoke it where it supports that, which also ends any copy of that token you hold. The default account cannot be deleted while other accounts exist: runs use the default, so another account must become the default first.",
  readOnly: false,
  risk: "destructive",
  permalink: noPermalink("mutation-only"),
  inputSchema: accountInput,
  async execute(input, context) {
    const { client, scope, result } = await resolveServerScope(input, context);
    const deleted = await client.deleteServerAccount(
      { ...scope, account: input.account },
      { signal: context.signal }
    );
    return { ...result, ...deleted };
  },
};
