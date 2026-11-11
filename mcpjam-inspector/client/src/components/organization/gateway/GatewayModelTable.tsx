import { useState } from "react";
import { Plus, Search, Trash2, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import type {
  GatewayCapability,
  GatewayCapabilityObservation,
  GatewayModel,
} from "@/shared/gateway-connection";
import { OrganizationModelPicker } from "../OrganizationModelPicker";

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
 * The gateway's models: each gateway name, the catalog model it runs as, and
 * the capability values an admin can correct. A corrected value reads "Set by
 * admin" and wins over a measured one until the admin clears it.
 */
export function GatewayModelTable({
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
  const replace = (nativeModelId: string, next: GatewayModel | null) =>
    onChange(
      models.flatMap((model) =>
        model.nativeModelId !== nativeModelId ? [model] : next ? [next] : [],
      ),
    );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search models"
            placeholder="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
          />
        </div>
        <div className="min-w-48 flex-1">
          <GatewayAddModel models={models} onChange={onChange} />
        </div>
      </div>
      <div className="rounded-md border border-border/60">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="min-w-56">Runs as</TableHead>
              {CAPABILITIES.map(([key, label]) => (
                <TableHead key={key}>{label}</TableHead>
              ))}
              <TableHead>
                <span className="sr-only">Remove</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={CAPABILITIES.length + 3}
                  className="py-4 text-center text-muted-foreground"
                >
                  {models.length === 0
                    ? "No models yet. Test the provider or add one above."
                    : `No model matches "${query.trim()}".`}
                </TableCell>
              </TableRow>
            ) : null}
            {visible.map((model) => (
              <TableRow key={model.nativeModelId}>
                <TableCell className="max-w-48 break-all align-top font-mono text-xs">
                  {model.nativeModelId}
                </TableCell>
                <TableCell className="align-top">
                  <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
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
                    </div>
                    {model.modelId ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Unmap ${model.nativeModelId}`}
                        onClick={() =>
                          replace(model.nativeModelId, withMapping(model, ""))
                        }
                      >
                        <X className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {model.modelId
                      ? MAPPING_SOURCE_LABELS[model.mappingSource ?? "admin"]
                      : "Not mapped"}
                  </p>
                </TableCell>
                {CAPABILITIES.map(([key, label]) => {
                  const observed = model.capabilities?.[key];
                  return (
                    <TableCell key={key} className="align-top">
                      <Select
                        value={observed?.status ?? "unknown"}
                        onValueChange={(value) =>
                          replace(
                            model.nativeModelId,
                            withCapability(
                              model,
                              key,
                              value as Status | typeof CLEAR,
                            ),
                          )
                        }
                      >
                        <SelectTrigger
                          size="sm"
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
                        <p className="mt-1 text-xs text-muted-foreground">
                          Set by admin
                        </p>
                      ) : null}
                    </TableCell>
                  );
                })}
                <TableCell className="align-top">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${model.nativeModelId}`}
                    onClick={() => replace(model.nativeModelId, null)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
