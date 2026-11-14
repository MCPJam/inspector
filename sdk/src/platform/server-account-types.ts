/**
 * A saved server's accounts as the API returns them. No type here carries a
 * token: uploads are write-only, and every read returns this view.
 */

/** One account a saved server signs in with. */
export type PlatformServerAccount = {
  /** Never changes, including while the account needs reconnecting. */
  id: string;
  /** `null` for an account nobody named. */
  name: string | null;
  /** `project` accounts belong to a server shared with the project. */
  kind: "personal" | "project";
  /** The effective default: the marked account, else the oldest. */
  isDefault: boolean;
  /** Its refresh was rejected, or it expired with no refresh token stored. */
  needsReconnect: boolean;
  /** Used by hosted runs only; never sent to a local app, browser or sandbox. */
  hostedOnly: boolean;
  /** Access-token expiry, epoch ms. */
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** The body `PUT .../accounts/{account}` takes. ID tokens are refused. */
export type PlatformServerAccountTokens = {
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  clientInformation: { clientId: string; clientSecret?: string };
};

export type PlatformServerAccountUpload = {
  account: PlatformServerAccount;
  /** True when the upload created the account (HTTP 201). */
  created: boolean;
};

export type PlatformServerAccountDeleted = {
  /** The id or name the delete addressed. */
  account: string;
  deleted: true;
};

/** `/projects/{p}/servers/{s}/accounts`, or one account under it. */
export function serverAccountsPath(
  scope: { projectId: string; serverId: string },
  account?: string
): string {
  const base = `/projects/${encodeURIComponent(
    scope.projectId
  )}/servers/${encodeURIComponent(scope.serverId)}/accounts`;
  return account === undefined
    ? base
    : `${base}/${encodeURIComponent(account)}`;
}
