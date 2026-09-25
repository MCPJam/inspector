/**
 * Picker row → saved {@link ModelSelection}.
 *
 * A picker row (`ModelDefinition`) knows whose credentials it runs on — the
 * hosted catalog, an organization provider connection, or a key on this
 * machine — but a bare model id does not, and that knowledge used to be
 * dropped at every save. These helpers turn the row into the saved selection
 * shape (`@mcpjam/sdk`) so the choice survives save → reload → run.
 *
 * Pure: no React, no network, no secrets. A selection names a connection
 * (`connectionRef`), never a key.
 *
 * ## Model id rule
 *
 * A selection's `modelId` is a canonical `provider/model` id: lowercase
 * provider segment (it may contain `:`), canonical vendor spellings
 * (`x-ai/`, `z-ai/`, `meta-llama/`, `mistralai/`, `qwen/` — never the Gateway
 * wire spellings `xai/`, `zai/`, `meta/`, `mistral/`, `alibaba/`).
 * {@link canonicalSelectionModelId} derives it from the picker row:
 *
 *  - an id that already has a lowercase `provider/` prefix is kept, with a
 *    Gateway-spelled prefix rewritten (`xai/grok-4` → `x-ai/grok-4`) — hosted
 *    catalog rows, OpenRouter rows, static Azure rows;
 *  - a bare own-provider id gets its provider's canonical prefix: `gpt-4o`
 *    (openai) → `openai/gpt-4o`, `grok-3` (xai) → `x-ai/grok-3`, Ollama
 *    `llama3.2:latest` → `ollama/llama3.2:latest`;
 *  - a custom-provider id `custom:<slug>:<model>` → `custom:<slug>/<model>`.
 *
 * Whenever the canonical id differs from the row id on an own-provider row,
 * the row id goes in `nativeModelId` — it is what the provider API is called
 * with, and what the runner executes. Anything that still fails the SDK
 * validator yields `null` (keep the legacy id).
 *
 * ## Persisting beside a legacy id
 *
 * Every storage boundary keeps its legacy id field (`model`, `modelId`,
 * `judgeModel`) and requires `selection.modelId` to equal it exactly. A
 * writer that stores a selection therefore stores `selection.modelId` as the
 * legacy id too ({@link storedModelChoice}); readers map it back to the picker
 * row with {@link findModelForStoredChoice}.
 */
import {
  defaultFallbackForPurpose,
  selectionKey,
  validateModelSelection,
  type ModelConnectionRef,
  type ModelSelection,
  type ModelSelectionPurpose,
} from "@mcpjam/sdk/browser";
import { getCanonicalModelId, type ModelDefinition } from "@/shared/types";
import {
  isMCPJamProvidedModelMenuItem,
  type OrgVisibleConfig,
} from "./model-helpers";

const PROVIDER_SEGMENT = /^[a-z0-9][a-z0-9._:-]*$/;

/**
 * Canonical vendor prefix for a provider key / Gateway spelling. Keys not
 * listed are already canonical (`openai`, `anthropic`, `ollama`, …).
 */
const CANONICAL_PROVIDER_PREFIX: Readonly<Record<string, string>> = {
  xai: "x-ai",
  zai: "z-ai",
  meta: "meta-llama",
  mistral: "mistralai",
  alibaba: "qwen",
};

function canonicalPrefix(prefix: string): string {
  return CANONICAL_PROVIDER_PREFIX[prefix] ?? prefix;
}

function isHostedRow(model: ModelDefinition): boolean {
  return model.hosted === true || isMCPJamProvidedModelMenuItem(model);
}

/** `custom:<slug>` for custom rows, else the row's provider. */
export function providerKeyForModelDefinition(model: ModelDefinition): string {
  const provider = String(model.provider);
  if (provider === "custom" && model.customProviderName) {
    return `custom:${model.customProviderName}`;
  }
  return provider;
}

/**
 * A picker row's identity: `${source}:${connectionRef?.id ?? providerKey}:${modelId}`.
 *
 * The raw row id alone collides: one id can be listed by the hosted catalog
 * and again under an org OpenRouter connection (or two org connections), and
 * a picker keyed by id checks, highlights and toggles both rows as one. The
 * source and connection part keeps them apart. `source` is `hosted` for
 * MCPJam rows, `org` for rows stamped with an org provider, else `local`;
 * the connection is the org provider row id when the stamp carries one, else
 * the provider key (`custom:<slug>` for custom providers).
 */
export function modelRowKey(model: ModelDefinition): string {
  const source = isHostedRow(model)
    ? "hosted"
    : model.orgProvider
      ? "org"
      : "local";
  const connection =
    model.orgProvider?.id?.trim() || providerKeyForModelDefinition(model);
  return `${source}:${connection}:${String(model.id)}`;
}

/**
 * Canonical selection `modelId` for a picker row (see the module comment), or
 * `null` when none can be formed.
 */
export function canonicalSelectionModelId(
  model: ModelDefinition,
): string | null {
  let raw = String(model.id ?? "").trim();
  if (!raw) return null;
  if (isHostedRow(model)) {
    raw = getCanonicalModelId(raw, String(model.provider));
  }
  const slash = raw.indexOf("/");
  if (slash > 0 && PROVIDER_SEGMENT.test(raw.slice(0, slash))) {
    return `${canonicalPrefix(raw.slice(0, slash))}${raw.slice(slash)}`;
  }
  if (isHostedRow(model)) return null;
  const provider = String(model.provider ?? "").toLowerCase();
  if (provider === "custom") {
    const name = model.customProviderName;
    if (!name) return null;
    const prefix = `custom:${name}:`;
    const native = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    return native ? `custom:${name.toLowerCase()}/${native}` : null;
  }
  if (!PROVIDER_SEGMENT.test(provider)) return null;
  return `${canonicalPrefix(provider)}/${raw}`;
}

/**
 * The org provider row that serves this picker row, when the list came from
 * an org config. Mirrors `buildAvailableModelsFromOrgConfig`: one row per
 * provider key; an org Ollama row only serves the ids it lists (a locally
 * detected Ollama model appended to an org list is the user's own).
 */
export function findOrgProviderForModel(
  model: ModelDefinition,
  orgConfig: OrgVisibleConfig | undefined,
): OrgVisibleConfig["providers"][number] | undefined {
  if (!orgConfig?.providers?.length) return undefined;
  const key = providerKeyForModelDefinition(model);
  const row = orgConfig.providers.find(
    (provider) => provider.providerKey === key && provider.enabled,
  );
  if (!row) return undefined;
  if (key === "ollama") {
    return row.modelIds?.includes(String(model.id)) ? row : undefined;
  }
  return row;
}

function localConnectionRef(model: ModelDefinition): ModelConnectionRef {
  const provider = String(model.provider);
  if (provider === "custom" && model.customProviderName) {
    return {
      kind: "localProvider",
      providerKey: "custom",
      customProviderName: model.customProviderName,
    };
  }
  return { kind: "localProvider", providerKey: provider };
}

/**
 * Build the saved selection for a picker row.
 *
 *  - hosted rows → `source: "hosted"`, no connection;
 *  - own-provider rows served by an org provider config (the row's
 *    `orgProvider` stamp, else a lookup in `orgConfig`) → `source: "org"`
 *    with `{ kind: "orgProvider", id }`. When the org config does not expose
 *    the provider row's id, returns `null`: a provider NAME cannot stand in for
 *    the connection, so the caller keeps the legacy id;
 *  - every other own-provider row (the user's local keys, locally detected
 *    Ollama, local custom providers) → `source: "local"` with
 *    `{ kind: "localProvider", providerKey, customProviderName? }`.
 *
 * `fallback` is the purpose's default (`defaultFallbackForPurpose`). Returns
 * `null` when the row cannot be expressed as a valid selection. The result is
 * validated by the SDK, which rejects any field outside the shape — a key can
 * never ride along.
 */
export function modelSelectionFromDefinition(
  model: ModelDefinition,
  orgConfig: OrgVisibleConfig | undefined,
  purpose: ModelSelectionPurpose,
): ModelSelection | null {
  const modelId = canonicalSelectionModelId(model);
  if (!modelId) return null;
  const fallback = defaultFallbackForPurpose(purpose);

  let candidate: ModelSelection;
  if (isHostedRow(model)) {
    candidate = { modelId, source: "hosted", fallback };
  } else {
    const rowId = String(model.id).trim();
    const nativeModelId =
      rowId !== modelId ? { nativeModelId: rowId } : undefined;
    // The row's own stamp (rows built from an org config carry it) wins;
    // otherwise look the row up in the org config the caller passed.
    const orgRow =
      model.orgProvider ?? findOrgProviderForModel(model, orgConfig);
    if (orgRow) {
      const id = typeof orgRow.id === "string" ? orgRow.id.trim() : "";
      if (!id) return null;
      candidate = {
        modelId,
        source: "org",
        connectionRef: { kind: "orgProvider", id },
        ...nativeModelId,
        fallback,
      };
    } else {
      candidate = {
        modelId,
        source: "local",
        connectionRef: localConnectionRef(model),
        ...nativeModelId,
        fallback,
      };
    }
  }

  const result = validateModelSelection(candidate);
  return result.ok ? result.selection : null;
}

/**
 * What a writer stores for a picked row: the legacy id field plus, when the
 * row can be expressed as one, the selection. With a selection the legacy id
 * IS `selection.modelId` (every storage boundary requires the two to agree);
 * without one it is the row id, exactly as before.
 */
export type StoredModelChoice = {
  modelId: string;
  selection?: ModelSelection;
};

export function storedModelChoice(
  model: ModelDefinition,
  orgConfig: OrgVisibleConfig | undefined,
  purpose: ModelSelectionPurpose,
): StoredModelChoice {
  const selection = modelSelectionFromDefinition(model, orgConfig, purpose);
  return selection
    ? { modelId: selection.modelId, selection }
    : { modelId: String(model.id) };
}

/**
 * The picker row a stored choice refers to.
 *
 * With a selection: the row whose own selection has the same `selectionKey`
 * (same source, same connection, same model) — so an id listed both in the
 * hosted catalog and under an org OpenRouter connection resolves to the row
 * that was actually picked. Without one (a legacy row): the row with that id,
 * hosted rows first, exactly as the legacy read did.
 */
export function findModelForStoredChoice(
  choice: { modelId: string; selection?: ModelSelection | null },
  models: readonly ModelDefinition[],
  orgConfig: OrgVisibleConfig | undefined,
): ModelDefinition | undefined {
  if (choice.selection) {
    const wanted = selectionKey(choice.selection);
    const match = models.find((model) => {
      const own = modelSelectionFromDefinition(model, orgConfig, "chat");
      return own !== null && selectionKey(own) === wanted;
    });
    if (match) return match;
  }
  const id = choice.modelId.trim();
  return (
    models.find((model) => String(model.id) === id && isHostedRow(model)) ??
    models.find((model) => String(model.id) === id)
  );
}

/**
 * The selection a writer may store beside the row's UNCHANGED legacy id: only
 * when `selection.modelId` is the row id itself (hosted rows, OpenRouter and
 * Azure rows — including one id listed both in the hosted catalog and on an
 * org OpenRouter connection). `undefined` for rows whose id is bare
 * (`gpt-4o`, `llama3.2:latest`, `custom:…`): surfaces that key their chips
 * and option lists by the raw row id keep saving the legacy id alone for
 * those until they can read a stored canonical id back
 * ({@link findModelForStoredChoice}).
 */
export function selectionBesideLegacyId(
  model: ModelDefinition,
  purpose: ModelSelectionPurpose,
  orgConfig?: OrgVisibleConfig,
): ModelSelection | undefined {
  const selection = modelSelectionFromDefinition(model, orgConfig, purpose);
  return selection && selection.modelId === String(model.id).trim()
    ? selection
    : undefined;
}

/** A test case's `models[]` entry, with its saved selection when it has one. */
export type CaseModelEntry = {
  provider: string;
  model: string;
  selection?: ModelSelection;
};

/**
 * The `models[]` entry a case model chip writes: the legacy `{ provider,
 * model }` pair plus the picked row's selection when it can be saved beside
 * that unchanged id ({@link selectionBesideLegacyId}). The row is the one the
 * chip names — same provider, same id — so an org OpenRouter row and the
 * hosted row of the same id (different providers) stay distinct.
 */
export function caseModelEntry(
  entry: { provider: string; model: string },
  models: readonly ModelDefinition[],
  /** The deployment stores selections; false ⇒ the legacy pair alone. */
  saveSelection = true,
): CaseModelEntry {
  if (!saveSelection) return { provider: entry.provider, model: entry.model };
  const row = models.find(
    (model) =>
      String(model.provider) === entry.provider &&
      String(model.id) === entry.model,
  );
  const selection = row
    ? selectionBesideLegacyId(row, "evalTarget")
    : undefined;
  return selection
    ? { provider: entry.provider, model: entry.model, selection }
    : { provider: entry.provider, model: entry.model };
}
