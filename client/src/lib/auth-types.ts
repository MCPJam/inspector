export interface AuthSettings {
  serverUrl: string;
  tokens: OAuthTokens | null;
  isAuthenticating: boolean;
  error: string | null;
  statusMessage: StatusMessage | null;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

export interface StatusMessage {
  type: "success" | "error" | "info";
  message: string;
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  serverUrl: "",
  tokens: null,
  isAuthenticating: false,
  error: null,
  statusMessage: null,
};
