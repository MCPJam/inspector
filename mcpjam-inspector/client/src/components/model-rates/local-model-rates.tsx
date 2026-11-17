import { useCallback, useEffect, useRef, useState } from "react";
import { useTraceCostEnabled } from "@/hooks/useTraceCostEnabled";
import { getProviderDisplayName } from "@/lib/provider-registry";
import { authFetch } from "@/lib/session-token";
import {
  modelRateRevisionZ,
  parseModelRateRevision,
  revisionInForce,
} from "@/shared/model-rate-revision";
import type { ModelRateRow } from "./model-rate-format";
import { ModelRatesPanel, type InForceRates } from "./model-rates-panel";

const BASE = "/api/mcp/model-rate-overrides";

/** Providers a personal key can run on this machine. */
const PROVIDERS =
  "anthropic openai google deepseek mistral xai openrouter azure bedrock ollama custom"
    .split(" ")
    .map((key) => ({ key, name: getProviderDisplayName(key) }));

/** A refusal the local server explained, as opposed to not reaching it. */
class ServerMessage extends Error {}

/** Rows the panel can show; a malformed one is dropped, not thrown on. */
const rowsOf = (value: unknown): ModelRateRow[] =>
  Array.isArray(value)
    ? value.flatMap(
        (row) => parseModelRateRevision(modelRateRevisionZ, row) ?? [],
      )
    : [];

/** The local server's answer, or an error carrying its message. */
async function request(path: string, body?: unknown) {
  const response = await authFetch(
    `${BASE}${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(await response.text()) ?? {};
  } catch {
    parsed = {}; // A proxy's HTML error page: answered below.
  }
  if (!response.ok || parsed.ok !== true) {
    throw typeof parsed.message === "string"
      ? new ServerMessage(parsed.message)
      : new Error(
          "Could not reach the Inspector server. Check that it is running and try again.",
        );
  }
  return parsed;
}

/**
 * Prices for the models you run on your own keys, kept by this Inspector on
 * this machine and used to estimate those calls. Local mode only, behind
 * `trace-cost`.
 */
export function LocalModelRates() {
  return useTraceCostEnabled() ? <LocalModelRatesPanel /> : null;
}

function LocalModelRatesPanel() {
  const [rates, setRates] = useState<ModelRateRow[]>();
  const [inForce, setInForce] = useState<InForceRates>();
  const [loadError, setLoadError] = useState<string>();
  // Only the newest reload may show its result: the first load can finish
  // after a save's reload and would put back the list from before the save.
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const loaded = rowsOf((await request("")).rates);
      // The list gives each series' newest revision, which can start later.
      // For those, the price in force today comes from the series' history.
      const now = Date.now();
      // A history that fails to load leaves only that rate without today's
      // price, as on the organization panel, not the whole list.
      const current = await Promise.all(
        loaded
          .filter((rate) => rate.effectiveAt > now)
          .map(async (rate) => {
            const series = new URLSearchParams({
              providerKey: rate.providerKey ?? "",
              modelId: rate.modelId,
            });
            try {
              const { revisions } = await request(`?${series}`);
              const row = revisionInForce(rowsOf(revisions), now) ?? null;
              return [[rate.rateId, row] as const];
            } catch {
              return [];
            }
          }),
      );
      if (mine !== generation.current) return;
      setRates(loaded);
      setInForce(new Map(current.flat()));
      setLoadError(undefined);
    } catch (error) {
      if (mine !== generation.current) return;
      // Show the server's own message, such as a storage failure. A raw
      // fetch error tells the user nothing they can act on.
      setLoadError(
        error instanceof ServerMessage
          ? error.message
          : "Could not load the prices stored on this machine. Try reloading the page.",
      );
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <ModelRatesPanel
      title="Model prices on this machine"
      description="Stored on this machine only and never uploaded. Calls on your own provider keys are estimated at these prices instead of the public list price."
      emptyText="No prices yet. Calls on your own provider keys are estimated at the public list price where one exists."
      rates={rates}
      inForce={inForce}
      loadError={loadError}
      canEdit
      requireProvider
      providers={PROVIDERS}
      defaultAuthor="You"
      onSave={async (rate) => {
        await request("", rate);
        await reload();
      }}
      onRetire={async (rate) => {
        await request(`/${encodeURIComponent(rate.rateId)}/retire`, {});
        await reload();
      }}
    />
  );
}
