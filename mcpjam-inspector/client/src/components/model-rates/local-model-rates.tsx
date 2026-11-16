import { useCallback, useEffect, useState } from "react";
import { useTraceCostEnabled } from "@/hooks/useTraceCostEnabled";
import { getProviderDisplayName } from "@/lib/provider-registry";
import { authFetch } from "@/lib/session-token";
import type { ModelRateRow } from "./model-rate-format";
import { ModelRatesPanel } from "./model-rates-panel";

const BASE = "/api/mcp/model-rate-overrides";

/** Providers a personal key can run on this machine. */
const PROVIDERS =
  "anthropic openai google deepseek mistral xai openrouter azure bedrock ollama custom"
    .split(" ")
    .map((key) => ({ key, name: getProviderDisplayName(key) }));

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
  let parsed: { ok?: unknown; message?: unknown; rates?: unknown } = {};
  try {
    parsed = JSON.parse(await response.text()) ?? {};
  } catch {
    parsed = {}; // A proxy's HTML error page: answered below.
  }
  if (!response.ok || parsed.ok !== true) {
    throw new Error(
      typeof parsed.message === "string"
        ? parsed.message
        : "Could not reach the Inspector server. Check that it is running and try again.",
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
  const [loadError, setLoadError] = useState<string>();
  const reload = useCallback(async () => {
    try {
      const { rates: loaded } = await request("");
      setRates(Array.isArray(loaded) ? (loaded as ModelRateRow[]) : []);
      setLoadError(undefined);
    } catch {
      // The server reports its own storage failures; a raw fetch error tells
      // the user nothing they can act on, so the panel names the next step.
      setLoadError(
        "Could not load the prices stored on this machine. Try reloading the page.",
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
      emptyText="No prices yet. Calls on your own keys are estimated at the public list price where one exists."
      rates={rates}
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
