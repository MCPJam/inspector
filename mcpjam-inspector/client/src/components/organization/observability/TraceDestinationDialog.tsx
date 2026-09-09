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

const DEFAULT_CORALOGIX_REGION = "eu2";

/**
 * The origin of a URL, or null when it does not parse.
 *
 * Used to decide whether an edit is pointing STORED credentials somewhere new.
 * A path or query change keeps the same origin and is harmless; a host change
 * would hand the vendor's key to whoever answers at the new one.
 */
function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * The region a stored Coralogix endpoint is in.
 *
 * Without this, editing a us1 destination shows the picker sitting on the
 * default — and touching any other field re-derives the endpoint from that
 * stale selection, silently moving the destination to another continent.
 */
function regionFromEndpoint(endpointUrl: string): string {
  const match = /^https:\/\/ingress\.([a-z0-9]+)\.coralogix\.com/i.exec(
    endpointUrl.trim(),
  );
  const region = match?.[1]?.toLowerCase();
  return region && (CORALOGIX_REGIONS as readonly string[]).includes(region)
    ? region
    : DEFAULT_CORALOGIX_REGION;
}

/**
 * Create or edit one trace destination.
 *
 * HEADER VALUES ARE WRITE-ONLY. The server never returns them — a destination
 * carries `headerNames` and nothing else — so editing shows a name with a
 * masked value and an empty input.
 *
 * THE SET IS REPLACE-ONLY, and the form has to say so rather than imply
 * otherwise. The backend takes `headers` as a whole set or not at all: there
 * is no per-header edit, because a partial update would have to read the
 * stored values to merge them and nothing may read them but the sender. So an
 * edit has exactly two outcomes:
 *
 *   - EVERY value left blank AND every name untouched → no `headers` is sent
 *     and the stored set survives. This is the common edit, where someone is
 *     changing the source list or the project allowlist.
 *   - anything else — a value typed, a row removed, a name changed → the
 *     whole set is replaced, so every remaining row needs its value typed
 *     again. `handleSubmit` refuses with that sentence rather than sending a
 *     partial set, because the alternative is a Remove button that quietly
 *     does nothing and a rename that is silently discarded.
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
  const [region, setRegion] = useState<string>(DEFAULT_CORALOGIX_REGION);
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
  /** The header names the server holds, to tell an edit of the set from a keep. */
  const [storedHeaderNames, setStoredHeaderNames] = useState<string[]>([]);

  // Reset from props every time the dialog opens, so reopening after a cancel
  // does not show the previous edit's half-typed state.
  useEffect(() => {
    if (!open) return;
    setLocalError(null);
    if (destination) {
      setName(destination.name);
      setPreset(destination.preset ?? "otlp");
      setEndpointUrl(destination.endpointUrl);
      setRegion(regionFromEndpoint(destination.endpointUrl));
      setStoredHeaderNames(destination.headerNames);
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
    setRegion(DEFAULT_CORALOGIX_REGION);
    setEndpointUrl("");
    setStoredHeaderNames([]);
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

  /**
   * Applying a preset fills what is empty; it never overwrites typed input.
   *
   * The endpoint included — it used to be the one field that contradicted
   * this, so someone who pasted their collector URL and THEN picked a vendor
   * for its header names lost the URL they had just typed.
   */
  const applyPreset = (nextPresetId: string) => {
    setPreset(nextPresetId);
    const next = presetById(nextPresetId);
    if (!next) return;
    if (!endpointUrl.trim()) {
      if (next.regional) {
        setEndpointUrl(coralogixIngressUrl(region as never));
      } else if (next.endpointUrl) {
        setEndpointUrl(next.endpointUrl);
      }
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

    // REPLACE-ONLY, resolved here. The set is being edited if any value was
    // typed OR the names no longer match what the server holds — a removed
    // row and a renamed row both land in the second case, and both used to be
    // silently dropped because neither carries a value.
    const namedRows = headerRows.filter((row) => row.key.trim());
    const currentNames = namedRows.map((row) => row.key.trim()).sort();
    const namesChanged =
      currentNames.length !== storedHeaderNames.length ||
      currentNames.some(
        (name, index) => name !== [...storedHeaderNames].sort()[index],
      );
    const anyValueTyped = namedRows.some((row) => row.value.length > 0);
    const replacingHeaders = anyValueTyped || namesChanged;

    // MOVING THE ENDPOINT MOVES THE CREDENTIALS WITH IT. Header values are
    // write-only, so an admin who never knew the stored key could otherwise
    // repoint this destination at a collector they control and read it off
    // the next delivery — which is exactly the thing write-only exists to
    // prevent. Changing the ORIGIN therefore requires re-entering the
    // headers, or clearing them by emptying every row. A path or query change
    // keeps the same origin and is left alone. The server enforces the same
    // rule; this is here so the form says so before the round trip.
    if (
      isEdit &&
      destination &&
      storedHeaderNames.length > 0 &&
      !replacingHeaders
    ) {
      const before = originOf(destination.endpointUrl);
      const after = originOf(endpointUrl);
      if (before && after && before !== after) {
        setLocalError(
          `This endpoint is moving to ${after}, and the stored headers would go with it. Re-enter them for the new endpoint, or remove them, before saving.`,
        );
        return;
      }
    }

    let headers: Record<string, string> | undefined;
    if (replacingHeaders) {
      const missing = namedRows.filter((row) => row.value.length === 0);
      if (missing.length > 0) {
        setLocalError(
          `Headers are replace-only — the server never hands a value back, so it cannot merge one in. Enter a value for ${missing
            .map((row) => `"${row.key.trim()}"`)
            .join(
              ", ",
            )}, or undo your changes to keep the stored headers as they are.`,
        );
        return;
      }
      headers = rowsToRecord(namedRows);
    }

    await onSubmit({
      name: name.trim(),
      endpointUrl: endpointUrl.trim(),
      ...(headers ? { headers } : {}),
      resourceAttributes: attributes,
      sourceTypes,
      includeContent,
      // `allProjects` is an UPDATE-only argument, and Convex rejects an
      // unrecognized one outright. On a create "every project" is expressed by
      // sending no `projectIds` at all — there is no stored allowlist to
      // clear, so a flag for clearing it has nothing to mean.
      ...(allProjects
        ? isEdit
          ? { allProjects: true }
          : {}
        : { projectIds }),
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
            hint={
              isEdit
                ? "Values are write-only — encrypted on save and never shown again, so the server cannot merge one in. Leave every value blank AND every name untouched to keep the stored headers; changing anything (a value, a name, a removed row) replaces the whole set, so every row then needs its value typed again."
                : "Values are write-only — they are encrypted on save and never shown again."
            }
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
