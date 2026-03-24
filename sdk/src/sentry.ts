import { createHash } from "node:crypto";
import packageJson from "../package.json";
import { EvalReportingError } from "./errors.js";

const SDK_SENTRY_DSN =
  "https://490f3f2a8a287f8a9f86eea23c16c01e@o4510109778378752.ingest.us.sentry.io/4511018761125888";
const SDK_VERSION = packageJson.version;
const SDK_RELEASE = `@mcpjam/sdk@${SDK_VERSION}`;
const API_KEY_HASH_LENGTH = 16;
const CAPTURED_ERROR_SYMBOL = Symbol.for("@mcpjam/sdk/captured-eval-error");

type SentryModule = typeof import("@sentry/node");
type SentryClient = InstanceType<SentryModule["NodeClient"]>;
type SentryScope = InstanceType<SentryModule["Scope"]>;
type LoadedSentry = {
  client: SentryClient;
  scope: SentryScope;
};

export type SdkSentryBreadcrumb = {
  category?: string;
  data?: Record<string, unknown>;
  level?: "debug" | "info" | "warning" | "error" | "fatal" | "log";
  message?: string;
  type?: string;
};

type CaptureContext = {
  extra?: Record<string, unknown>;
  fingerprint?: string[];
  tags?: Record<string, string | undefined>;
  user?: { id: string };
};

export type EvalReportingFailureContext = {
  apiKey?: string;
  artifactFormat?: string;
  baseUrl?: string;
  bufferedCount?: number;
  entrypoint: string;
  framework?: string;
  resultCount?: number;
  runId?: string | null;
  suiteName?: string;
};

let sentryStatePromise: Promise<LoadedSentry | null> | null = null;
let sdkSentryDsn = SDK_SENTRY_DSN;
let sentryModuleLoader: () => Promise<SentryModule | null> = async () =>
  await import("@sentry/node");

function isTelemetryDisabled(): boolean {
  return (
    process.env.DO_NOT_TRACK === "1" ||
    process.env.MCPJAM_TELEMETRY_DISABLED === "1"
  );
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : String(error));
}

function isMissingOptionalDependency(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("code" in error &&
      ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(
        (error as Error & { code?: string }).code ?? ""
      )) &&
    error.message.includes("@sentry/node")
  );
}

function markErrorCaptured(error: Error): void {
  Object.defineProperty(error, CAPTURED_ERROR_SYMBOL, {
    configurable: true,
    enumerable: false,
    value: true,
  });
}

function hasCapturedError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (
      (current as Error & { [CAPTURED_ERROR_SYMBOL]?: boolean })[
        CAPTURED_ERROR_SYMBOL
      ] === true
    ) {
      return true;
    }
    current =
      "cause" in current ? (current as Error & { cause?: unknown }).cause : null;
  }

  return false;
}

function getApiKeyHash(apiKey?: string): string | undefined {
  if (!apiKey) {
    return undefined;
  }

  return createHash("sha256")
    .update(apiKey)
    .digest("hex")
    .slice(0, API_KEY_HASH_LENGTH);
}

function findEvalReportingError(error: unknown): EvalReportingError | null {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof EvalReportingError) {
      return current;
    }
    current =
      "cause" in current ? (current as Error & { cause?: unknown }).cause : null;
  }

  return null;
}

async function loadSentry(): Promise<LoadedSentry | null> {
  if (isTelemetryDisabled() || !sdkSentryDsn) {
    return null;
  }

  if (!sentryStatePromise) {
    sentryStatePromise = sentryModuleLoader()
      .then((sentry) => {
        if (!sentry) {
          return null;
        }

        const client = new sentry.NodeClient({
          defaultIntegrations: false,
          dsn: sdkSentryDsn,
          integrations: [],
          release: SDK_RELEASE,
          sendDefaultPii: false,
          sendClientReports: false,
          stackParser: sentry.defaultStackParser,
          transport: sentry.makeNodeTransport,
        });
        client.init();

        const scope = new sentry.Scope();
        scope.setClient(client);
        scope.setTag("sdk.version", SDK_VERSION);
        scope.setTag("node.version", process.version);
        scope.setTag("platform", process.platform);

        return { client, scope };
      })
      .catch((error) => {
        if (isMissingOptionalDependency(error)) {
          return null;
        }
        return null;
      });
  }

  return await sentryStatePromise;
}

async function withScope(
  context: CaptureContext,
  callback: (scope: SentryScope) => void
): Promise<void> {
  const state = await loadSentry();
  if (!state) {
    return;
  }

  try {
    const scope = state.scope.clone();

    if (context.tags) {
      for (const [key, value] of Object.entries(context.tags)) {
        if (value !== undefined) {
          scope.setTag(key, value);
        }
      }
    }

    if (context.extra) {
      for (const [key, value] of Object.entries(context.extra)) {
        if (value !== undefined) {
          scope.setExtra(key, value);
        }
      }
    }

    if (context.fingerprint) {
      scope.setFingerprint(context.fingerprint);
    }

    if (context.user) {
      scope.setUser(context.user);
    }

    callback(scope);
  } catch {
    // Optional telemetry must never affect SDK behavior.
  }
}

export async function captureException(
  error: unknown,
  context: CaptureContext = {}
): Promise<void> {
  const exception = normalizeError(error);
  await withScope(context, (scope) => {
    scope.captureException(exception);
  });
}

export async function captureMessage(
  message: string,
  context: CaptureContext = {}
): Promise<void> {
  await withScope(context, (scope) => {
    scope.captureMessage(message);
  });
}

export async function addBreadcrumb(
  breadcrumb: SdkSentryBreadcrumb
): Promise<void> {
  const state = await loadSentry();
  if (!state) {
    return;
  }

  try {
    state.scope.addBreadcrumb(breadcrumb);
  } catch {
    // Optional telemetry must never affect SDK behavior.
  }
}

export async function captureEvalReportingFailure(
  error: unknown,
  context: EvalReportingFailureContext
): Promise<void> {
  const exception = normalizeError(error);
  if (hasCapturedError(exception)) {
    return;
  }

  markErrorCaptured(exception);

  const evalReportingError = findEvalReportingError(exception);
  const apiKeyHash = getApiKeyHash(context.apiKey);
  await captureException(exception, {
    user: apiKeyHash ? { id: apiKeyHash } : undefined,
    extra: {
      artifact_format: context.artifactFormat,
      baseUrl: context.baseUrl,
      buffered_count: context.bufferedCount,
      framework: context.framework,
      has_api_key: Boolean(context.apiKey),
      result_count: context.resultCount,
      runId: context.runId ?? undefined,
    },
    tags: {
      api_key_hash: apiKeyHash,
      endpoint: evalReportingError?.endpoint,
      entrypoint: context.entrypoint,
      http_status:
        evalReportingError?.statusCode !== undefined
          ? String(evalReportingError.statusCode)
          : undefined,
      suite_name: context.suiteName,
    },
  });
}

export function __resetSentryForTests(): void {
  sdkSentryDsn = SDK_SENTRY_DSN;
  sentryStatePromise = null;
  sentryModuleLoader = async () => await import("@sentry/node");
}

export function __setSentryModuleLoaderForTests(
  loader: () => Promise<SentryModule | null>
): void {
  sentryStatePromise = null;
  sentryModuleLoader = loader;
}

export function __setSentryDsnForTests(dsn: string): void {
  sdkSentryDsn = dsn;
  sentryStatePromise = null;
}
