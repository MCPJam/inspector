/**
 * The server account methods of `PlatformApiClient`, kept out of `client.ts`.
 *
 * `PlatformApiClient` extends this class and implements `request`, so these
 * are ordinary client methods: on the prototype chain, typed, and sent with
 * the client's own authentication, headers, deadline and error mapping.
 * Accounts are addressed by id or by name, and no method returns a token.
 */
import {
  serverAccountsPath,
  type PlatformServerAccount,
  type PlatformServerAccountDeleted,
  type PlatformServerAccountTokens,
  type PlatformServerAccountUpload,
} from "./server-account-types.js";
import type { PlatformPage } from "./types.js";

type ServerScope = { projectId: string; serverId: string };
type AccountScope = ServerScope & { account: string };
// The options every client method takes.
type RequestOptions = { signal?: AbortSignal; idempotencyKey?: string };

export abstract class ServerAccountClient {
  protected abstract request<T>(
    method: "GET" | "PUT" | "PATCH" | "DELETE",
    path: string,
    init: { body?: unknown; onStatus?: (status: number) => void },
    options?: RequestOptions
  ): Promise<T>;

  listServerAccounts(
    params: ServerScope,
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformServerAccount>> {
    return this.request("GET", serverAccountsPath(params), {}, options);
  }

  getServerAccount(
    params: AccountScope,
    options?: RequestOptions
  ): Promise<PlatformServerAccount> {
    const path = serverAccountsPath(params, params.account);
    return this.request("GET", path, {}, options);
  }

  /** Create the account (`created: true`) or replace its token in place. */
  async uploadServerAccountTokens(
    params: AccountScope & { body: PlatformServerAccountTokens },
    options?: RequestOptions
  ): Promise<PlatformServerAccountUpload> {
    let status = 0;
    const account = await this.request<PlatformServerAccount>(
      "PUT",
      serverAccountsPath(params, params.account),
      {
        body: params.body,
        onStatus: (answered) => {
          status = answered;
        },
      },
      options
    );
    return { account, created: status === 201 };
  }

  /** Rename and/or make default; renaming applies first. */
  updateServerAccount(
    params: AccountScope & { body: { name?: string; isDefault?: true } },
    options?: RequestOptions
  ): Promise<PlatformServerAccount> {
    const path = serverAccountsPath(params, params.account);
    return this.request("PATCH", path, { body: params.body }, options);
  }

  deleteServerAccount(
    params: AccountScope,
    options?: RequestOptions
  ): Promise<PlatformServerAccountDeleted> {
    const path = serverAccountsPath(params, params.account);
    return this.request("DELETE", path, {}, options);
  }
}
