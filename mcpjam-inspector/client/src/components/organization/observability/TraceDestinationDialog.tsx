import { useEffect, useMemo, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Switch } from "@mcpjam/design-system/switch";
import { Plus, Trash2 } from "lucide-react";
import type {
  TraceDestination,
  TraceDestinationInput,
  TraceDestinationSourceType,
} from "@/hooks/useOrgTraceDestinations";
import {
  CORALOGIX_REGIONS,
  SOURCE_TYPE_OPTIONS,
  VENDOR_PRESETS,
  coralogixIngressUrl,
  presetById,
} from "./presets";

/**
 * Create or edit one trace destination.
 *
 * HEADER VALUES ARE WRITE-ONLY. The server never returns them — a destination
 * carries `headerNames` and nothing else — so editing shows a name with a
 * masked value and an empty input. Leaving every value blank on an edit sends
 * no `headers` at all, which the backend reads as "leave the stored set
 * alone"; typing into any one of them REPLACES the whole set, because that is
 * what the backend's `headers` argument does and pretending otherwise would
 * silently drop the headers the admin did not retype.
 */

interface KeyValueRow {
  id: number;
  key: string;
  value: string;
  /** True for a header that exists server-side and has not been retyped. */
  stored?: boolean;
}

let rowSeq = 0;
function makeRow(key = "", value = "", stored = false): KeyValueRow {
  rowSeq += 1;
  return { id: rowSeq, key, value, stored };
}

function rowsToRecord(rows: KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    out[key] = row.value;
  }
  return out;
}

interface TraceDestinationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent means create. */
  destination?: TraceDestination | null;
  projects: Array<{ id: string; name: string }>;
  isSaving: boolean;
  error: string | null;
  onSubmit: (
    input: TraceDestinationInput & { allProjects?: boolean },
  ) => Promise<void>;
}

export function TraceDestinationDialog({
  open,
  onOpenChange,
  destination,
  projects,
  isSaving,
  error,
  onSubmit,
}: TraceDestinationDialogProps) {
  const isEdit = Boolean(destination);

  const [name, setName] = useState("");
  const [preset, setPreset] = useState<string>("otlp");
  const [region, setRegion] = useState<string>("eu2");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>([]);
  const [attrRows, setAttrRows] = useState<KeyValueRow[]>([]);
  const [sourceTypes, setSourceTypes] = useState<TraceDestinationSourceType[]>([
    "eval",
  ]);
  const [includeContent, setIncludeContent] = useState(false);
  const [allProjects, setAllProjects] = useState(true);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [compression, setCompression] = useState<"gzip" | "none">("none");
  const [enabled, setEnabled] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  // Reset from props every time the dialog opens, so reopening after a cancel
  // does not show the previous edit's half-typed state.
  useEffect(() => {
    if (!open) return;
    setLocalError(null);
    if (destination) {
      setName(destination.name);
      setPreset(destination.preset ?? "otlp");
      setEndpointUrl(destination.endpointUrl);
      setHeaderRows(
        destination.headerNames.map((headerName) =>
          makeRow(headerName, "", true),
        ),
      );
      setAttrRows(
        Object.entries(destination.resourceAttributes).map(([key, value]) =>
          makeRow(key, value),
        ),
      );
      setSourceTypes(destination.sourceTypes);
      setIncludeContent(destination.includeContent);
      setAllProjects(destination.projectIds === null);
      setProjectIds(destination.projectIds ?? []);
      setCompression(destination.compression);
      setEnabled(destination.enabled);
      return;
    }
    setName("");
    setPreset("otlp");
    setRegion("eu2");
    setEndpointUrl("");
    setHeaderRows([makeRow()]);
    setAttrRows([makeRow()]);
    setSourceTypes(["eval"]);
    setIncludeContent(false);
    setAllProjects(true);
    setProjectIds([]);
    setCompression("none");
    setEnabled(true);
  }, [destination, open]);

  const selectedPreset = useMemo(() => presetById(preset), [preset]);

  /** Applying a preset fills what is empty; it never overwrites typed input. */
  const applyPreset = (nextPresetId: string) => {
    setPreset(nextPresetId);
    const next = presetById(nextPresetId);
    if (!next) return;
    if (next.regional) {
      setEndpointUrl(coralogixIngressUrl(region as never));
    } else if (next.endpointUrl) {
      setEndpointUrl(next.endpointUrl);
    }
    if (next.compression) setCompression(next.compression);
    setHeaderRows((rows) => {
      const existing = new Set(
        rows.map((row) => row.key.trim().toLowerCase()).filter(Boolean),
      );
      const added = next.headerNames
        .filter((headerName) => !existing.has(headerName.toLowerCase()))
        .map((headerName) => makeRow(headerName));
      const kept = rows.filter((row) => row.key.trim() || row.value.trim());
      return [...kept, ...added];
    });
    setAttrRows((rows) => {
      const existing = new Set(
        rows.map((row) => row.key.trim()).filter(Boolean),
      );
      const added = next.suggestedAttributes
        .filter((key) => !existing.has(key))
        .map((key) => makeRow(key));
      const kept = rows.filter((row) => row.key.trim() || row.value.trim());
      return [...kept, ...added];
    });
  };

  const toggleSource = (id: TraceDestinationSourceType, on: boolean) => {
    setSourceTypes((current) =>
      on ? [...new Set([...current, id])] : current.filter((s) => s !== id),
    );
  };

  const handleSubmit = async () => {
    const attributes = rowsToRecord(attrRows);
    // Same rule the server enforces, checked here so the message arrives
    // before the round trip. `mcpjam.*` is the provenance namespace the
    // exporter owns; a destination that could overwrite it could lie about
    // which run a span came from.
    const reserved = Object.keys(attributes).find((key) =>
      key.startsWith("mcpjam."),
    );
    if (reserved) {
      setLocalError(
        `Resource attribute "${reserved}" is reserved — mcpjam.* names are set by the exporter.`,
      );
      return;
    }
    if (sourceTypes.length === 0) {
      setLocalError(
        "Pick at least one source, or the destination sends nothing.",
      );
      return;
    }
    if (!allProjects && projectIds.length === 0) {
      setLocalError("Pick at least one project, or choose all projects.");
      return;
    }
    setLocalError(null);

    // Only rows the admin actually typed a value into. On an edit, none means
    // "leave the stored headers alone"; on a create there is nothing stored,
    // so the same expression is simply the headers.
    const typedHeaders = headerRows.filter(
      (row) => row.key.trim() && row.value.length > 0,
    );
    const headers =
      typedHeaders.length > 0 ? rowsToRecord(typedHeaders) : undefined;

    await onSubmit({
      name: name.trim(),
      endpointUrl: endpointUrl.trim(),
      ...(headers ? { headers } : {}),
      resourceAttributes: attributes,
      sourceTypes,
      includeContent,
      ...(allProjects ? { allProjects: true } : { projectIds }),
      compression,
      preset,
      enabled,
    });
  };

  const shownError = localError ?? error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit trace destination" : "New trace destination"}
          </DialogTitle>
          <DialogDescription>
            Traces are pushed continuously over OTLP/HTTP. Delivery is
            at-least-once, so a destination may see the same span twice.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <Label htmlFor="td-name">Name</Label>
            <Input
              id="td-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Coralogix (production)"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="td-preset">Vendor</Label>
            <Select value={preset} onValueChange={applyPreset}>
              <SelectTrigger id="td-preset">
                <SelectValue placeholder="Pick a vendor" />
              </SelectTrigger>
              <SelectContent>
                {VENDOR_PRESETS.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedPreset?.hint ? (
              <p className="text-xs text-muted-foreground">
                {selectedPreset.hint}
              </p>
            ) : null}
          </div>

          {selectedPreset?.regional ? (
            <div className="space-y-2">
              <Label htmlFor="td-region">Region</Label>
              <Select
                value={region}
                onValueChange={(next) => {
                  setRegion(next);
                  setEndpointUrl(coralogixIngressUrl(next as never));
                }}
              >
                <SelectTrigger id="td-region">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CORALOGIX_REGIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="td-endpoint">Endpoint URL</Label>
            <Input
              id="td-endpoint"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              placeholder="https://otlp.example.com"
            />
            <p className="text-xs text-muted-foreground">
              HTTPS only. <code>/v1/traces</code> is appended if the path does
              not already end there.
            </p>
          </div>

          <KeyValueEditor
            legend="Headers"
            hint="Values are write-only — they are encrypted on save and never shown again. On an edit, leave every value blank to keep the stored headers; typing any value replaces all of them."
            keyPlaceholder="Authorization"
            valuePlaceholder="Bearer …"
            secret
            rows={headerRows}
            onChange={setHeaderRows}
          />

          <KeyValueEditor
            legend="Resource attributes"
            hint="Added to every exported resource. mcpjam.* names are reserved."
            keyPlaceholder="cx.application.name"
            valuePlaceholder="mcpjam"
            rows={attrRows}
            onChange={setAttrRows}
          />

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Sources</legend>
            {SOURCE_TYPE_OPTIONS.map((option) => (
              <label
                key={option.id}
                className="flex items-start gap-2 text-sm"
                htmlFor={`td-source-${option.id}`}
              >
                <Checkbox
                  id={`td-source-${option.id}`}
                  checked={sourceTypes.includes(option.id)}
                  onCheckedChange={(c) => toggleSource(option.id, c === true)}
                  className="mt-0.5"
                />
                <span>
                  {option.label}
                  <span className="block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Projects</legend>
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor="td-all-projects"
            >
              <Checkbox
                id="td-all-projects"
                checked={allProjects}
                onCheckedChange={(c) => setAllProjects(c === true)}
              />
              <span>Every project in this organization</span>
            </label>
            {!allProjects ? (
              <div className="space-y-1 pl-6">
                {projects.map((project) => (
                  <label
                    key={project.id}
                    className="flex items-center gap-2 text-sm"
                    htmlFor={`td-project-${project.id}`}
                  >
                    <Checkbox
                      id={`td-project-${project.id}`}
                      checked={projectIds.includes(project.id)}
                      onCheckedChange={(c) =>
                        setProjectIds((current) =>
                          c === true
                            ? [...new Set([...current, project.id])]
                            : current.filter((id) => id !== project.id),
                        )
                      }
                    />
                    <span>{project.name}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </fieldset>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={includeContent}
              onCheckedChange={(c) => setIncludeContent(c === true)}
              className="mt-0.5"
            />
            <span>
              Include content &amp; artifacts
              <span className="block text-xs text-muted-foreground">
                Prompts, outputs, tool args/results, and screenshots. Off by
                default — these can contain secrets.
              </span>
            </span>
          </label>

          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Advanced
            </summary>
            <div className="mt-3 space-y-2">
              <Label htmlFor="td-compression">Compression</Label>
              <Select
                value={compression}
                onValueChange={(next) =>
                  setCompression(next as "gzip" | "none")
                }
              >
                <SelectTrigger id="td-compression">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="gzip">gzip</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                gzip is optional in OTLP/HTTP. Some intakes reject it; turn it
                off if deliveries start failing with a 400.
              </p>
            </div>
          </details>

          <div className="flex items-center justify-between">
            <Label htmlFor="td-enabled">Enabled</Label>
            <Switch
              id="td-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>

          {shownError ? (
            <p className="text-sm text-destructive" role="alert">
              {shownError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isSaving ? "Saving…" : isEdit ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyValueEditor({
  legend,
  hint,
  keyPlaceholder,
  valuePlaceholder,
  secret,
  rows,
  onChange,
}: {
  legend: string;
  hint: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  secret?: boolean;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
}) {
  const patch = (id: number, next: Partial<KeyValueRow>) =>
    onChange(
      rows.map((row) =>
        row.id === id ? { ...row, ...next, stored: false } : row,
      ),
    );

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2">
          <Input
            aria-label={`${legend} name`}
            value={row.key}
            placeholder={keyPlaceholder}
            onChange={(e) => patch(row.id, { key: e.target.value })}
          />
          <Input
            aria-label={`${legend} value`}
            type={secret ? "password" : "text"}
            value={row.value}
            placeholder={row.stored ? "••••• (set)" : valuePlaceholder}
            onChange={(e) => patch(row.id, { value: e.target.value })}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${legend.toLowerCase()} row`}
            onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, makeRow()])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        Add
      </Button>
    </fieldset>
  );
}
