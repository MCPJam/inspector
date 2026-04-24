import { randomInt } from "node:crypto";
import {
  DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  getConformanceAuthCodeDynamicRegistrationMetadata,
  getConformanceClientCredentialsDynamicRegistrationMetadata,
} from "./oauth/client-identity.js";
import {
  resolveAuthorizationPlan,
  type OAuthProtocolMode,
  type OAuthRegistrationMode,
  type ResolvedAuthorizationPlan,
} from "./oauth/authorization-plan.js";
import { createOAuthStateMachine } from "./oauth/state-machines/factory.js";
import { runOAuthStateMachine } from "./oauth/state-machines/runner.js";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type OAuthFlowState,
  type OAuthHttpRequest,
  type OAuthProtocolVersion,
} from "./oauth/state-machines/types.js";
import { canonicalizeResourceUrl } from "./oauth/state-machines/shared/urls.js";
import { performClientCredentialsGrant } from "./oauth-conformance/auth-strategies/client-credentials.js";
import { completeHeadlessAuthorization } from "./oauth-conformance/auth-strategies/headless.js";
import {
  createInteractiveAuthorizationSession,
  type InteractiveAuthorizationSession,
} from "./oauth-conformance/auth-strategies/interactive.js";
import {
  normalizeOAuthConformanceConfig,
} from "./oauth-conformance/validation.js";
import type {
  ClientCredentialsResult,
  NormalizedOAuthConformanceConfig,
  OAuthConformanceConfig,
  OAuthVerificationConfig,
  TrackedRequestFn,
  VerificationResult,
} from "./oauth-conformance/types.js";
import type { HttpServerConfig } from "./mcp-client-manager/index.js";
import { listTools, withEphemeralClient } from "./operations.js";
import { probeMcpServer } from "./server-probe.js";

export interface OAuthLoginConfig
  extends Omit<
    OAuthConformanceConfig,
    "protocolVersion" | "registrationStrategy"
  > {
  protocolVersion?: OAuthProtocolVersion;
  registrationStrategy?:
    | NormalizedOAuthConformanceConfig["registrationStrategy"]
    | undefined;
  protocolMode?: OAuthProtocolMode;
  registrationMode?: OAuthRegistrationMode;
}

export interface OAuthLoginResult {
  completed: boolean;
  serverUrl: string;
  protocolVersion: NormalizedOAuthConformanceConfig["protocolVersion"];
  registrationStrategy?:
    | NormalizedOAuthConformanceConfig["registrationStrategy"]
    | undefined;
  protocolMode: OAuthProtocolMode;
  registrationMode: OAuthRegistrationMode;
  authMode: NormalizedOAuthConformanceConfig["auth"]["mode"];
  redirectUrl: string;
  currentStep: OAuthFlowState["currentStep"];
  authorizationUrl?: string;
  authorizationPlan: ResolvedAuthorizationPlan;
  credentials: {
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    expiresIn?: number;
  };
  verification?: VerificationResult;
  error?: {
    message: string;
  };
  state: OAuthFlowState;
}

export interface OAuthLoginDependencies {
  createInteractiveAuthorizationSession?: typeof createInteractiveAuthorizationSession;
  completeHeadlessAuthorization?: typeof completeHeadlessAuthorization;
  performClientCredentialsGrant?: typeof performClientCredentialsGrant;
  createDefaultRedirectUrl?: () => string;
}

function cloneEmptyFlowState(): OAuthFlowState {
  return {
    ...EMPTY_OAUTH_FLOW_STATE,
    httpHistory: [],
    infoLogs: [],
  };
}

function createDefaultRedirectUrl(): string {
  return `http://127.0.0.1:${randomInt(20000, 60000)}/callback`;
}

function normalizeResponseHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key.toLowerCase()] = value;
  });
  return normalized;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    contentType.includes("application/json") ||
    contentType.includes("+json")
  ) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

function serializeRequestBody(
  body: OAuthHttpRequest["body"],
  headers: Record<string, string>,
): BodyInit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === "string" || body instanceof URLSearchParams) {
    return body;
  }

  const contentType =
    Object.entries(headers).find(
      ([key]) => key.toLowerCase() === "content-type",
    )?.[1] ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(
      Object.entries(body as Record<string, string>).map(([key, value]) => [
        key,
        String(value),
      ]),
    ).toString();
  }

  return JSON.stringify(body);
}

function normalizeLoginAuthConfig(
  auth: OAuthLoginConfig["auth"],
) : NonNullable<OAuthConformanceConfig["auth"]> {
  return auth ?? { mode: "interactive" };
}

function normalizeLoginClientConfig(
  client: OAuthLoginConfig["client"],
): NonNullable<OAuthConformanceConfig["client"]> {
  return client ?? {};
}

function resolveRequestedProtocolMode(
  input: Pick<OAuthLoginConfig, "protocolMode" | "protocolVersion">,
): OAuthProtocolMode {
  if (input.protocolMode) {
    return input.protocolMode;
  }

  return input.protocolVersion ?? "auto";
}

function resolveRequestedRegistrationMode(
  input: Pick<OAuthLoginConfig, "registrationMode" | "registrationStrategy">,
): OAuthRegistrationMode {
  if (input.registrationMode) {
    return input.registrationMode;
  }

  return input.registrationStrategy ?? "auto";
}

function toAuthorizationPlanInput(
  input: OAuthLoginConfig,
): Parameters<typeof resolveAuthorizationPlan>[0] {
  const auth = normalizeLoginAuthConfig(input.auth);
  const client = normalizeLoginClientConfig(input.client);

  return {
    serverUrl: input.serverUrl,
    protocolMode: resolveRequestedProtocolMode(input),
    protocolVersion: input.protocolVersion,
    registrationMode: resolveRequestedRegistrationMode(input),
    registrationStrategy: input.registrationStrategy,
    clientId: client.preregistered?.clientId,
    clientSecret: client.preregistered?.clientSecret,
    clientIdMetadataUrl: client.clientIdMetadataUrl,
    authMode: auth.mode,
  };
}

async function resolveOAuthLoginAuthorizationPlan(
  input: OAuthLoginConfig,
): Promise<ResolvedAuthorizationPlan> {
  const basePlan = resolveAuthorizationPlan(toAuthorizationPlanInput(input));

  if (basePlan.status !== "discovery_required") {
    return basePlan;
  }

  const probe = await probeMcpServer({
    url: input.serverUrl,
    protocolVersion: basePlan.protocolVersion,
    headers: input.customHeaders,
    timeoutMs: input.stepTimeout,
    fetchFn: input.fetchFn,
  });

  return resolveAuthorizationPlan({
    ...toAuthorizationPlanInput(input),
    discovery: probe.oauth,
  });
}

function mergeDynamicRegistration(
  config: NormalizedOAuthConformanceConfig,
  redirectUrl: string,
): NormalizedOAuthConformanceConfig["client"]["dynamicRegistration"] {
  const defaults =
    config.auth.mode === "client_credentials"
      ? getConformanceClientCredentialsDynamicRegistrationMetadata()
      : getConformanceAuthCodeDynamicRegistrationMetadata();

  const merged = {
    ...defaults,
    ...config.client.dynamicRegistration,
  };

  if (config.auth.mode === "client_credentials") {
    delete merged.redirect_uris;
    delete merged.response_types;
  } else {
    merged.redirect_uris = config.client.dynamicRegistration?.redirect_uris ?? [
      redirectUrl,
    ];
    merged.response_types = config.client.dynamicRegistration?.response_types ?? [
      "code",
    ];
  }

  return merged;
}

async function runVerification(
  config: NormalizedOAuthConformanceConfig,
  state: OAuthFlowState,
  verificationConfig: OAuthVerificationConfig,
): Promise<VerificationResult | undefined> {
  if (!verificationConfig.listTools || !state.accessToken) {
    return undefined;
  }

  const result: VerificationResult = {};
  const verifyConfig: HttpServerConfig = {
    url: config.serverUrl,
    accessToken: state.accessToken,
    requestInit: config.customHeaders
      ? { headers: config.customHeaders }
      : undefined,
    timeout: verificationConfig.timeout ?? 30_000,
  };

  try {
    await withEphemeralClient(
      verifyConfig,
      async (manager, serverId) => {
        const listStartedAt = Date.now();
        try {
          const toolsResult = await listTools(manager, { serverId });
          result.listTools = {
            passed: true,
            toolCount: toolsResult.tools.length,
            durationMs: Date.now() - listStartedAt,
          };
        } catch (error) {
          result.listTools = {
            passed: false,
            durationMs: Date.now() - listStartedAt,
            error: error instanceof Error ? error.message : String(error),
          };
          return;
        }

        if (!verificationConfig.callTool) {
          return;
        }

        const callStartedAt = Date.now();
        try {
          await manager.executeTool(
            serverId,
            verificationConfig.callTool.name,
            verificationConfig.callTool.params ?? {},
          );
          result.callTool = {
            passed: true,
            toolName: verificationConfig.callTool.name,
            durationMs: Date.now() - callStartedAt,
          };
        } catch (error) {
          result.callTool = {
            passed: false,
            toolName: verificationConfig.callTool.name,
            durationMs: Date.now() - callStartedAt,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      {
        timeout: verificationConfig.timeout ?? 30_000,
      },
    );
  } catch (error) {
    if (!result.listTools) {
      result.listTools = {
        passed: false,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return result;
}

function buildResult(
  config: NormalizedOAuthConformanceConfig,
  authorizationPlan: ResolvedAuthorizationPlan,
  redirectUrl: string,
  state: OAuthFlowState,
  verification?: VerificationResult,
  error?: string,
): OAuthLoginResult {
  return {
    completed: state.currentStep === "complete" && !error,
    serverUrl: config.serverUrl,
    protocolVersion: config.protocolVersion,
    registrationStrategy: config.registrationStrategy,
    protocolMode: authorizationPlan.protocolMode,
    registrationMode: authorizationPlan.registrationMode,
    authMode: config.auth.mode,
    redirectUrl,
    currentStep: state.currentStep,
    authorizationUrl: state.authorizationUrl,
    authorizationPlan,
    credentials: {
      clientId: state.clientId,
      clientSecret: state.clientSecret,
      accessToken: state.accessToken,
      refreshToken: state.refreshToken,
      tokenType: state.tokenType,
      expiresIn: state.expiresIn,
    },
    ...(verification ? { verification } : {}),
    ...(error ? { error: { message: error } } : {}),
    state,
  };
}

function buildBlockedPlanResult(
  input: OAuthLoginConfig,
  authorizationPlan: ResolvedAuthorizationPlan,
  state: OAuthFlowState,
): OAuthLoginResult {
  const auth = normalizeLoginAuthConfig(input.auth);

  return {
    completed: false,
    serverUrl: input.serverUrl.trim(),
    protocolVersion: authorizationPlan.protocolVersion,
    registrationStrategy: authorizationPlan.registrationStrategy,
    protocolMode: authorizationPlan.protocolMode,
    registrationMode: authorizationPlan.registrationMode,
    authMode: auth.mode,
    redirectUrl: input.redirectUrl?.trim() || "",
    currentStep: state.currentStep,
    authorizationPlan,
    credentials: {},
    error: {
      message:
        authorizationPlan.blockers[0] ?? authorizationPlan.summary,
    },
    state,
  };
}

export async function runOAuthLogin(
  input: OAuthLoginConfig,
  deps: OAuthLoginDependencies = {},
): Promise<OAuthLoginResult> {
  let state = cloneEmptyFlowState();
  let redirectUrl =
    input.redirectUrl ??
    (deps.createDefaultRedirectUrl ?? createDefaultRedirectUrl)();
  let interactiveSession: InteractiveAuthorizationSession | undefined;

  const updateState = (updates: Partial<OAuthFlowState>) => {
    state = { ...state, ...updates };
  };
  const getState = () => state;

  try {
    const authorizationPlan = await resolveOAuthLoginAuthorizationPlan(input);
    if (
      authorizationPlan.status !== "ready" ||
      !authorizationPlan.registrationStrategy
    ) {
      return buildBlockedPlanResult(input, authorizationPlan, state);
    }

    const config = normalizeOAuthConformanceConfig({
      ...input,
      protocolVersion: authorizationPlan.protocolVersion,
      registrationStrategy: authorizationPlan.registrationStrategy,
      client: {
        ...normalizeLoginClientConfig(input.client),
        ...(authorizationPlan.clientIdMetadataUrl
          ? { clientIdMetadataUrl: authorizationPlan.clientIdMetadataUrl }
          : {}),
      },
      oauthConformanceChecks: false,
    });

    if (config.auth.mode === "interactive") {
      interactiveSession = await (
        deps.createInteractiveAuthorizationSession ??
        createInteractiveAuthorizationSession
      )({
        redirectUrl: config.redirectUrl,
      });
    }

    redirectUrl =
      interactiveSession?.redirectUrl ??
      redirectUrl;

    const trackedRequest: TrackedRequestFn = async (request, options = {}) => {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        config.stepTimeout,
      );

      try {
        const response = await config.fetchFn(request.url, {
          method: request.method,
          headers: request.headers,
          body: serializeRequestBody(request.body, request.headers),
          redirect: options.redirect,
          signal: controller.signal,
        });
        const body = await parseResponseBody(response);
        return {
          status: response.status,
          statusText: response.statusText,
          headers: normalizeResponseHeaders(response.headers),
          body,
          ok: response.ok,
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Step timed out after ${config.stepTimeout}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
      }
    };

    const machineConfig = {
      protocolVersion: config.protocolVersion,
      registrationStrategy: config.registrationStrategy,
      state,
      getState,
      updateState,
      serverUrl: config.serverUrl,
      serverName: config.serverName,
      redirectUrl,
      requestExecutor: (request: OAuthHttpRequest) => trackedRequest(request),
      loadPreregisteredCredentials: async () => ({
        clientId: config.client.preregistered?.clientId,
        clientSecret: config.client.preregistered?.clientSecret,
      }),
      dynamicRegistration: mergeDynamicRegistration(config, redirectUrl),
      clientIdMetadataUrl:
        config.client.clientIdMetadataUrl ??
        DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
      customScopes: config.scopes,
      customHeaders: config.customHeaders,
      authMode: config.auth.mode,
    } as const;

    if (config.auth.mode !== "client_credentials") {
      const flowResult = await runOAuthStateMachine({
        ...machineConfig,
        maxSteps: 40,
        onAuthorizationRequest: async ({ authorizationUrl, state: flowState }) => {
          try {
            config.onProgress("Opening browser for authorization...");
            const authorizationResult =
              config.auth.mode === "interactive"
                ? await interactiveSession!.authorize({
                    authorizationUrl,
                    expectedState: flowState.state,
                    timeoutMs: config.stepTimeout,
                    openUrl: config.auth.openUrl,
                  })
                : await (
                    deps.completeHeadlessAuthorization ??
                    completeHeadlessAuthorization
                  )({
                    authorizationUrl,
                    redirectUrl,
                    expectedState: flowState.state,
                    request: trackedRequest,
                  });

            config.onProgress("Authorization received, exchanging token...");
            return {
              type: "authorization_code" as const,
              authorizationCode: authorizationResult.code,
            };
          } catch (error) {
            updateState({
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      });

      if (flowResult.error) {
        const resultState =
          flowResult.state.currentStep === "authorization_request" &&
          flowResult.state.authorizationUrl
            ? {
                ...flowResult.state,
                // Preserve the SDK login helper's historical contract: once an
                // authorization URL exists, failures in the browser/headless
                // handoff are reported as failing to receive the auth code.
                currentStep: "received_authorization_code" as const,
              }
            : flowResult.state;
        return buildResult(
          config,
          authorizationPlan,
          redirectUrl,
          resultState,
          undefined,
          flowResult.error.message,
        );
      }

      const verification = await runVerification(
        config,
        flowResult.state,
        config.verification,
      );
      return buildResult(
        config,
        authorizationPlan,
        redirectUrl,
        flowResult.state,
        verification,
      );
    }

    const machine = createOAuthStateMachine(machineConfig);

    let guard = 0;
    while (state.currentStep !== "complete" && guard < 40) {
      guard += 1;

      if (
        config.auth.mode === "client_credentials" &&
        state.currentStep === "received_client_credentials"
      ) {
        if (!state.authorizationServerMetadata?.token_endpoint) {
          return buildResult(
            config,
            authorizationPlan,
            redirectUrl,
            state,
            undefined,
            "Missing token endpoint for client_credentials flow.",
          );
        }

        if (
          config.registrationStrategy === "dcr" &&
          (!state.clientId || !state.clientSecret)
        ) {
          return buildResult(
            config,
            authorizationPlan,
            redirectUrl,
            state,
            undefined,
            "Dynamic registration produced a public client and cannot be used for client_credentials.",
          );
        }

        try {
          const tokenResult: ClientCredentialsResult = await (
            deps.performClientCredentialsGrant ??
            performClientCredentialsGrant
          )({
            tokenEndpoint: state.authorizationServerMetadata.token_endpoint,
            clientId: state.clientId || config.auth.clientId,
            clientSecret: state.clientSecret || config.auth.clientSecret,
            tokenEndpointAuthMethod: state.tokenEndpointAuthMethod,
            scope: config.scopes,
            resource: canonicalizeResourceUrl(config.serverUrl),
            request: trackedRequest,
          });

          updateState({
            currentStep: "received_access_token",
            accessToken: tokenResult.accessToken,
            refreshToken: tokenResult.refreshToken,
            tokenType: tokenResult.tokenType,
            expiresIn: tokenResult.expiresIn,
            lastResponse: {
              status: tokenResult.tokenResponse.status,
              statusText: tokenResult.tokenResponse.statusText,
              headers: tokenResult.tokenResponse.headers,
              body: tokenResult.tokenResponse.body,
            },
            error: undefined,
          });
          continue;
        } catch (error) {
          return buildResult(
            config,
            authorizationPlan,
            redirectUrl,
            state,
            undefined,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      const startStep = state.currentStep;
      try {
        await machine.proceedToNextStep();
      } catch (error) {
        return buildResult(
          config,
          authorizationPlan,
          redirectUrl,
          state,
          undefined,
          error instanceof Error ? error.message : String(error),
        );
      }

      if (state.currentStep === startStep) {
        return buildResult(
          config,
          authorizationPlan,
          redirectUrl,
          state,
          undefined,
          state.error || `Step ${startStep} did not advance.`,
        );
      }
    }

    if (guard >= 40 && state.currentStep !== "complete") {
      return buildResult(
        config,
        authorizationPlan,
        redirectUrl,
        state,
        undefined,
        "OAuth login exceeded its step guard.",
      );
    }

    if (config.verification.listTools) {
      config.onProgress("Verifying token with server...");
    }
    const verification = await runVerification(
      config,
      state,
      config.verification,
    );
    return buildResult(
      config,
      authorizationPlan,
      redirectUrl,
      state,
      verification,
    );
  } finally {
    await interactiveSession?.stop().catch(() => undefined);
  }
}
