/**
 * The connection Test for a gateway whose calls come from each user's
 * Inspector: the probes the backend's `testProviderConnection` runs, made from
 * this process instead, because MCPJam's servers never call such a gateway.
 * List its models, make one minimal call per API, and read LiteLLM's model
 * routing for mapping suggestions.
 *
 * Every request goes through the hosted egress guard (plain fetch locally) and
 * never follows a redirect, since it carries the admin's key. Each probe stops
 * after 10 seconds or 64 KiB, and only a short excerpt of what the gateway
 * said comes back: hosted, the base URL is typed by a caller, so this must not
 * become a way to read pages through our network.
 */
import {
  BlockedEgressTargetError,
  EgressResolutionError,
} from "./hosted-egress-guard.js";
import {
  GATEWAY_APIS,
  gatewayApiUrl,
  type GatewayApi,
  type GatewayConnectionTestResult,
  type GatewayEndpoint,
} from "@/shared/gateway-connection";

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BODY_BYTES = 64 * 1024;
const GATEWAY_TEXT_MAX_CHARS = 300;
const MAX_LISTED_MODELS = 500;

type ApiResult = GatewayConnectionTestResult["apis"][GatewayApi];

export type GatewayProbeInput = {
  baseUrl: string;
  secret?: string;
  apis?: readonly GatewayApi[];
  /** A guarded fetch (`createCheckedAddressFetch`). */
  fetch: typeof fetch;
  /** Catalog ids (`provider/model`) a gateway name may be matched to. */
  catalogIds: readonly string[];
};

type Outcome =
  | { kind: "response"; url: string; status: number; body: string }
  | { kind: "stopped"; refused: boolean; message: string };

const PING = { role: "user", content: "ping" };
const API_BODIES: Record<GatewayApi, (model: string) => object> = {
  chatCompletions: (model) => ({ model, messages: [PING], max_tokens: 1 }),
  anthropicMessages: (model) => ({ model, max_tokens: 1, messages: [PING] }),
  responses: (model) => ({ model, input: "ping", max_output_tokens: 16 }),
  embeddings: (model) => ({ model, input: "ping" }),
};
const NOT_CHAT =
  /embed|rerank|whisper|tts|transcri|dall-e|image|moderation|audio/i;

/** The first listed model suited to an API, or none (the API is untested). */
function modelFor(api: GatewayApi, ids: readonly string[]) {
  if (api === "embeddings") return ids.find((id) => /embed/i.test(id));
  const chat = ids.filter((id) => !NOT_CHAT.test(id));
  if (api === "anthropicMessages") {
    return chat.find((id) => /claude/i.test(id)) ?? chat[0];
  }
  return chat[0];
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON (an HTML error page, or a body cut at the read limit).
    return undefined;
  }
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < PROBE_MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = value.subarray(0, PROBE_MAX_BODY_BYTES - size);
    chunks.push(take);
    size += take.byteLength;
  }
  await reader.cancel();
  return Buffer.concat(chunks).toString("utf8");
}

/** What the gateway said, from its error JSON or its raw text, cut short. */
function gatewayText(body: string): string | undefined {
  const parsed = parseJson(body);
  const error = field(parsed, "error");
  const said = [
    field(error, "message"),
    error,
    field(parsed, "message"),
    field(parsed, "detail"),
  ].find((value): value is string => typeof value === "string");
  const text = (said ?? (parsed === undefined ? body : ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > GATEWAY_TEXT_MAX_CHARS
    ? `${text.slice(0, GATEWAY_TEXT_MAX_CHARS - 1)}…`
    : text;
}

function statusMessage(
  outcome: { url: string; status: number; body: string },
  hasKey: boolean,
): string {
  const said = gatewayText(outcome.body);
  const quoted = said ? `: "${said}"` : "";
  if (outcome.status === 401) {
    return hasKey
      ? `The provider rejected the API key${quoted}. Check the key and test again.`
      : `The provider asked for an API key${quoted}. Enter the key, then test again.`;
  }
  if (outcome.status === 403) {
    return `The provider refused the request${quoted}. Check the key's budget and model access on the provider.`;
  }
  if (outcome.status === 404) {
    return `The provider has nothing at ${outcome.url}. Check the base URL and the APIs this connection serves.`;
  }
  if (outcome.status >= 300 && outcome.status < 400) {
    return `The provider redirected ${outcome.url} elsewhere. Enter the address it redirects to as the base URL.`;
  }
  return `The provider returned an error${quoted}. Check the provider's logs, then test again.`;
}

async function send(
  input: GatewayProbeInput,
  endpoint: GatewayEndpoint,
  anthropicAuth: boolean,
  body?: object,
): Promise<Outcome> {
  const url = gatewayApiUrl(input.baseUrl, endpoint);
  const headers: Record<string, string> = anthropicAuth
    ? {
        "anthropic-version": "2023-06-01",
        ...(input.secret ? { "x-api-key": input.secret } : {}),
      }
    : input.secret
      ? { authorization: `Bearer ${input.secret}` }
      : {};
  if (body) headers["content-type"] = "application/json";
  try {
    const response = await input.fetch(url, {
      method: body ? "POST" : "GET",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return {
      kind: "response",
      url,
      status: response.status,
      body: await readBounded(response),
    };
  } catch (error) {
    const host = new URL(url).host;
    if (error instanceof BlockedEgressTargetError) {
      return {
        kind: "stopped",
        refused: true,
        message: `This Inspector won't call ${host}. It calls only public addresses it can look up, and private ones an operator lists in MCPJAM_PRIVATE_EGRESS_ALLOWLIST.`,
      };
    }
    // Never the error's own text: a connect error names the address the host
    // resolved to, which a refusal must not reveal.
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      kind: "stopped",
      refused: false,
      message: timedOut
        ? `${host} didn't answer within ${PROBE_TIMEOUT_MS / 1000} seconds. Check that the provider is running, then test again.`
        : error instanceof EgressResolutionError
          ? `This Inspector couldn't look up ${host}. Check the hostname, then test again.`
          : `This Inspector couldn't connect to ${host}. Check the base URL and that the provider is running.`,
    };
  }
}

const succeeded = (outcome: Outcome) =>
  outcome.kind === "response" && outcome.status >= 200 && outcome.status < 300;

function listedModelIds(body: string): string[] {
  const data = field(parseJson(body), "data");
  // A list cut at the read limit is not JSON; the ids before the cut still count.
  const ids = Array.isArray(data)
    ? data.map((entry) => field(entry, "id"))
    : [...body.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
  const named = ids.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  return [...new Set(named)].slice(0, MAX_LISTED_MODELS);
}

/** What LiteLLM reports each model name routes to (`litellm_params.model`). */
async function reportedRoutes(input: GatewayProbeInput) {
  const routes = new Map<string, string>();
  const outcome = await send(input, "modelInfo", false);
  if (outcome.kind !== "response" || !succeeded(outcome)) return routes;
  const data = field(parseJson(outcome.body), "data");
  for (const entry of Array.isArray(data) ? data : []) {
    const name = field(entry, "model_name");
    const model = field(field(entry, "litellm_params"), "model");
    if (typeof name === "string" && typeof model === "string") {
      routes.set(name, model);
    }
  }
  return routes;
}

/** `4-5` and `4.5` spell one version (Anthropic's API and the catalog). */
const versionKey = (id: string) =>
  id.toLowerCase().replace(/(\d)-(?=\d)/g, "$1.");

/**
 * Catalog ids for gateway names: what the gateway reports routing a name to,
 * then the name alone when it equals one catalog model's own part.
 */
function suggestModels(
  ids: readonly string[],
  routes: ReadonlyMap<string, string>,
  catalogIds: readonly string[],
): GatewayConnectionTestResult["models"] {
  const byId = new Map<string, string>();
  const byPart = new Map<string, string | null>();
  for (const id of catalogIds) {
    byId.set(versionKey(id), id);
    const part = versionKey(id.slice(id.indexOf("/") + 1));
    byPart.set(part, byPart.has(part) ? null : id);
  }
  const lookup = (name: string) =>
    byId.get(versionKey(name)) ??
    (name.includes("/")
      ? undefined
      : (byPart.get(versionKey(name)) ?? undefined));
  return ids.map((nativeModelId) => {
    const reported = routes.get(nativeModelId);
    const fromGateway = reported ? lookup(reported) : undefined;
    if (fromGateway) {
      return {
        nativeModelId,
        suggestedModelId: fromGateway,
        suggestionSource: "gateway",
      };
    }
    const byName = lookup(nativeModelId);
    return byName
      ? { nativeModelId, suggestedModelId: byName, suggestionSource: "name" }
      : { nativeModelId };
  });
}

async function probeApi(
  input: GatewayProbeInput,
  api: GatewayApi,
  ids: readonly string[],
): Promise<NonNullable<ApiResult>> {
  const model = modelFor(api, ids);
  if (!model) return { result: "untested" };
  const outcome = await send(
    input,
    api,
    api === "anthropicMessages",
    API_BODIES[api](model),
  );
  if (outcome.kind !== "response") {
    return { result: "failed", message: outcome.message };
  }
  if (succeeded(outcome)) return { result: "ok", status: outcome.status };
  return {
    result: "failed",
    status: outcome.status,
    message: statusMessage(outcome, Boolean(input.secret)),
  };
}

export async function probeGatewayConnection(
  input: GatewayProbeInput,
): Promise<GatewayConnectionTestResult> {
  const requested: GatewayApi[] = input.apis?.length
    ? [...new Set(input.apis)]
    : [...GATEWAY_APIS];
  const stopped = (
    fields: Omit<GatewayConnectionTestResult, "origin" | "apis" | "models">,
  ): GatewayConnectionTestResult => ({
    origin: "inspector",
    ...fields,
    apis: Object.fromEntries(
      requested.map((api) => [api, { result: "untested" as const }]),
    ),
    models: [],
  });
  const listing = await send(
    input,
    "models",
    requested.every((api) => api === "anthropicMessages"),
  );
  if (listing.kind === "stopped") {
    const { message } = listing;
    return stopped({
      reachable: false,
      message,
      ...(listing.refused
        ? { refusal: { code: "egress_refused", message } }
        : {}),
    });
  }
  if (!succeeded(listing)) {
    return stopped({
      reachable: true,
      status: listing.status,
      message: statusMessage(listing, Boolean(input.secret)),
    });
  }

  const ids = listedModelIds(listing.body);
  const [results, routes] = await Promise.all([
    Promise.all(requested.map((api) => probeApi(input, api, ids))),
    ids.length > 0 ? reportedRoutes(input) : new Map<string, string>(),
  ]);
  return {
    reachable: true,
    origin: "inspector",
    status: listing.status,
    ...(ids.length === 0
      ? {
          message:
            "The provider listed no models. Add models to the provider, then test again.",
        }
      : {}),
    apis: Object.fromEntries(requested.map((api, i) => [api, results[i]])),
    models: suggestModels(ids, routes, input.catalogIds),
  };
}
