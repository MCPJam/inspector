import { useState } from "react";
import { MoreHorizontal, Plus, Search } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type {
  GatewayCapability,
  GatewayCapabilityObservation,
  GatewayModel,
} from "@/shared/gateway-connection";
import { pluralize } from "@/components/chat-v2/shared/chat-helpers";
import { OrganizationModelPicker } from "../OrganizationModelPicker";
import { STATUS_TONE_CLASSES } from "../org-ai-config-presentation";

const CAPABILITIES: Array<[GatewayCapability, string]> = [
  ["tools", "Tools"],
  ["vision", "Vision"],
  ["structuredOutput", "Structured output"],
  ["reasoning", "Reasoning"],
];

const MAPPING_SOURCE_LABELS: Record<
  NonNullable<GatewayModel["mappingSource"]>,
  string
> = {
  name: "Matched by name",
  gateway: "Reported by the provider",
  admin: "Set by admin",
};

/** The admin's value goes; the measured one, if any, applies again. */
const CLEAR = "clear";

type Status = GatewayCapabilityObservation["status"];

function withCapability(
  model: GatewayModel,
  capability: GatewayCapability,
  value: Status | typeof CLEAR,
): GatewayModel {
  const capabilities = { ...model.capabilities };
  delete capabilities[capability];
  if (value !== CLEAR) {
    capabilities[capability] = {
      status: value,
      source: "declared",
      observedAt: Date.now(),
    };
  }
  return { ...model, capabilities };
}

function withMapping(model: GatewayModel, modelId: string): GatewayModel {
  const next: GatewayModel = { ...model };
  delete next.modelId;
  delete next.mappingSource;
  return modelId ? { ...next, modelId, mappingSource: "admin" } : next;
}

/** Past this many models, the mapping list gets a search box. */
const SEARCH_FROM = 8;

/** A model the provider serves but didn't list, added by its name. */
export function GatewayAddModel({
  models,
  onChange,
}: {
  models: GatewayModel[];
  onChange: (models: GatewayModel[]) => void;
}) {
  const [added, setAdded] = useState("");
  const addModel = () => {
    const name = added.trim();
    if (!name || models.some((model) => model.nativeModelId === name)) return;
    onChange([...models, { nativeModelId: name }]);
    setAdded("");
  };
  return (
    <div className="flex gap-2">
      <Input
        aria-label="Add a model"
        placeholder="Add a model the provider serves"
        value={added}
        onChange={(event) => setAdded(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          addModel();
        }}
      />
      <Button type="button" variant="outline" onClick={addModel}>
        <Plus className="size-4" />
        Add
      </Button>
    </div>
  );
}

/**
 * The provider's models and the catalog model each runs as, the part admins
 * come back for: map, unmap, add or remove a model.
 */
export function GatewayModelMapping({
  models,
  catalogIds,
  onChange,
}: {
  models: GatewayModel[];
  catalogIds: string[];
  onChange: (models: GatewayModel[]) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = models.filter(
    (model) =>
      !needle ||
      model.nativeModelId.toLowerCase().includes(needle) ||
      model.modelId?.toLowerCase().includes(needle),
  );
  const unmapped = models.filter((model) => !model.modelId).length;
  const replace = (nativeModelId: string, next: GatewayModel | null) =>
    onChange(
      models.flatMap((model) =>
        model.nativeModelId !== nativeModelId ? [model] : next ? [next] : [],
      ),
    );

  return (
    <section aria-labelledby="gateway-models" className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-4">
          <h3 id="gateway-models" className="text-sm font-medium">
            Models
          </h3>
          <span className="text-xs text-muted-foreground">
            {pluralize(models.length, "model")}
            {unmapped > 0 ? ` · ${unmapped} not mapped` : ""}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Choose the catalog model each one runs as. Harness clients only run
          mapped models.
        </p>
      </div>
      {models.length > SEARCH_FROM ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search models"
            placeholder="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
          />
        </div>
      ) : null}
      <ul className="divide-y divide-border/60 rounded-md border border-border/60">
        {visible.length === 0 ? (
          <li className="px-3 py-4 text-center text-sm text-muted-foreground">
            {models.length === 0
              ? "No models yet. Test again or add one below."
              : `No model matches "${query.trim()}".`}
          </li>
        ) : null}
        {visible.map((model) => (
          <li
            key={model.nativeModelId}
            className="flex items-start gap-3 px-3 py-2.5"
          >
            <p className="w-2/5 shrink-0 break-all pt-2.5 font-mono text-xs">
              {model.nativeModelId}
            </p>
            <div className="min-w-0 flex-1 space-y-1.5">
              <OrganizationModelPicker
                id={`gateway-runs-as-${model.nativeModelId}`}
                label={`Runs as for ${model.nativeModelId}`}
                value={model.modelId ?? ""}
                suggestions={catalogIds}
                isAzure={false}
                onChange={(id) =>
                  replace(model.nativeModelId, withMapping(model, id))
                }
              />
              {model.modelId ? (
                <p className="text-xs text-muted-foreground">
                  {MAPPING_SOURCE_LABELS[model.mappingSource ?? "admin"]}
                </p>
              ) : (
                <Badge
                  variant="outline"
                  className={STATUS_TONE_CLASSES.warning}
                >
                  Not mapped
                </Badge>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Actions for ${model.nativeModelId}`}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {model.modelId ? (
                  <DropdownMenuItem
                    onSelect={() =>
                      replace(model.nativeModelId, withMapping(model, ""))
                    }
                  >
                    Unmap
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => replace(model.nativeModelId, null)}
                >
                  Remove model
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
      <GatewayAddModel models={models} onChange={onChange} />
    </section>
  );
}

/**
 * The capability values an admin can correct, per model. A corrected value
 * reads "Set by admin" and wins over a measured one until the admin clears it.
 */
export function GatewayCapabilityOverrides({
  models,
  onChange,
}: {
  models: GatewayModel[];
  onChange: (models: GatewayModel[]) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Correct a value when a model supports more or less than measured. Your
        value applies until you clear it.
      </p>
      <ul className="space-y-4">
        {models.map((model) => (
          <li key={model.nativeModelId} className="space-y-2">
            <p className="font-mono text-xs">{model.nativeModelId}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CAPABILITIES.map(([key, label]) => {
                const observed = model.capabilities?.[key];
                const id = `gateway-${key}-${model.nativeModelId}`;
                return (
                  <div key={key} className="min-w-0 space-y-1">
                    <Label
                      htmlFor={id}
                      className="text-xs font-normal text-muted-foreground"
                    >
                      {label}
                    </Label>
                    <Select
                      value={observed?.status ?? "unknown"}
                      onValueChange={(value) =>
                        onChange(
                          models.map((each) =>
                            each === model
                              ? withCapability(
                                  model,
                                  key,
                                  value as Status | typeof CLEAR,
                                )
                              : each,
                          ),
                        )
                      }
                    >
                      <SelectTrigger
                        id={id}
                        size="sm"
                        className="w-full"
                        aria-label={`${label} for ${model.nativeModelId}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="supported">Supported</SelectItem>
                        <SelectItem value="unsupported">
                          Not supported
                        </SelectItem>
                        <SelectItem value="unknown">Unknown</SelectItem>
                        {observed?.source === "declared" ? (
                          <SelectItem value={CLEAR}>
                            Clear admin value
                          </SelectItem>
                        ) : null}
                      </SelectContent>
                    </Select>
                    {observed?.source === "declared" ? (
                      <p className="text-xs text-muted-foreground">
                        Set by admin
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
