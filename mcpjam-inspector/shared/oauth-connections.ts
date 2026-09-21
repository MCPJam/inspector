export type ConnectionIntent =
  | { kind: "add" }
  | { kind: "replace"; credentialId: string };
export interface OAuthConnection {
  connectionId: string;
  label?: string;
  profile?: {
    id: string;
    name?: string;
    email?: string;
    nickname?: string;
    capturedAt?: number;
  };
  isDefault: boolean;
  needsReauth?: boolean;
  authorizedAt?: number;
  expiresAt?: number;
}
export interface AuthorizedOAuthConnection extends OAuthConnection {
  accessToken?: string | null;
  unavailableReason?: string;
}
export function connectionLabel(c: OAuthConnection, index = 0): string {
  return (
    c.label ||
    c.profile?.email ||
    c.profile?.name ||
    c.profile?.nickname ||
    `Account ${index + 1}`
  );
}
