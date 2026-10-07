import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Check,
  Eye,
  FileText,
  Folder,
  Image as ImageIcon,
  LayoutGrid,
  Plus,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SchemaFormFieldControl } from "./SchemaFormFieldControl";
import { parseElicitationSchema } from "../elicitation/schema";
import {
  PluginDescribedError,
  waitForPluginOperation,
} from "@/shared/plugin-operation";
import {
  pluginFormOptions,
  pluginFormFreeArray,
  pluginFormResources,
  pluginFormPreview,
  pluginFormThumbnailSource,
  type PluginFormPlan,
  type PluginFormPreview,
} from "@/shared/plugin-extensions/form-plan";

/** Trusted owned host services; metadata is not an authority to fetch or run tools. */
export type PluginFormPorts = {
  /** Presentation only; labels never grant access to a resource. */
  resourceLabel?: (uri: string) => string;
  chooseResources?: (
    options: { kind?: "file" | "directory"; accept?: string[] },
    signal: AbortSignal,
    context: { field: string; multiple: boolean },
  ) => Promise<string[]>;
  /** Settles within a bounded time. A failure the host can explain is a
   * `PluginDescribedError`; the field shows its message. */
  preview?: (
    target: PluginFormPreview,
    signal: AbortSignal,
  ) => Promise<{ content: ReactNode; release: () => void }>;
};

/** More than this many resource cards collapse behind "View all". */
const RESOURCE_ROW_LIMIT = 3;

/**
 * An option's image, or the fallback image. One rule with the form's Logs
 * warning (`pluginFormThumbnailSource`): HTTPS or a base64 image data URI.
 * A thumbnail is one icon, so its `theme` never hides it; `sizes` don't
 * matter because the image is fitted to the square.
 */
function Thumbnail({ value, size }: { value: unknown; size: "row" | "card" }) {
  const src = pluginFormThumbnailSource(value);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <span
      aria-hidden="true"
      data-thumbnail={size}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden bg-muted",
        size === "row"
          ? "size-10 rounded-md border border-border"
          : "aspect-[4/3] w-full rounded-t-lg",
      )}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-contain"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <ImageIcon
          className={cn(
            "text-muted-foreground",
            size === "row" ? "size-4" : "size-6",
          )}
        />
      )}
    </span>
  );
}

type Choice = {
  value: string;
  label: string;
  description?: string;
  thumbnail?: unknown;
  /** A value the user typed rather than one the server offered. */
  custom?: boolean;
};

function CheckMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input",
      )}
    >
      {checked && <Check className="size-3" />}
    </span>
  );
}

function KeyMark({ index, checked }: { index: number; checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums",
        checked
          ? "border-foreground bg-foreground text-background"
          : "border-border text-muted-foreground",
      )}
    >
      {index < 9 ? (
        index + 1
      ) : checked ? (
        <span className="size-2 rounded-full bg-background" />
      ) : null}
    </span>
  );
}

/**
 * The shared choice list for titled options, thumbnails, plain enums and
 * suggested values: a number key (single choice) or a checkbox (several),
 * an optional square thumbnail, then title and description. Number keys
 * 1–9 select through `data-choice-key`.
 */
function ChoiceRows({
  choices,
  images,
  selected,
  multiple,
  disabled,
  label,
  onToggle,
  children,
}: {
  choices: Choice[];
  images: boolean;
  selected: unknown;
  multiple: boolean;
  disabled: boolean;
  label: string;
  onToggle: (choice: Choice, index: number, checked: boolean) => void;
  /** Trailing rows (the inline add/other entry). */
  children?: ReactNode;
}) {
  return (
    <div
      className="-mx-1 min-w-0 space-y-0.5"
      role={multiple ? "group" : "radiogroup"}
      aria-label={label}
    >
      {choices.map((choice, index) => {
        // A typed entry is in the list by definition; unchecking removes it.
        const checked = choice.custom
          ? true
          : multiple
          ? Array.isArray(selected) && selected.includes(choice.value)
          : selected === choice.value;
        return (
          <button
            key={`${choice.custom ? "custom" : "offered"}:${index}`}
            type="button"
            role={multiple ? "checkbox" : "radio"}
            aria-checked={checked}
            aria-label={`${choice.label || "Empty value"}${
              choice.description ? ` ${choice.description}` : ""
            }`}
            disabled={disabled}
            data-choice-key={index < 9 ? index + 1 : undefined}
            onClick={() => onToggle(choice, index, checked)}
            className={cn(
              "flex w-full min-w-0 items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors [overflow-wrap:anywhere] hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-60",
              checked && "bg-muted",
            )}
          >
            {multiple ? (
              <CheckMark checked={checked} />
            ) : (
              <KeyMark index={index} checked={checked} />
            )}
            {images && <Thumbnail value={choice.thumbnail} size="row" />}
            <span className="min-w-0 flex-1">
              <span className="block text-sm">
                {choice.label || "Empty value"}
              </span>
              {choice.description && (
                <span className="block text-xs text-muted-foreground">
                  {choice.description}
                </span>
              )}
            </span>
          </button>
        );
      })}
      {children}
    </div>
  );
}

/** An RFC 3339 `date-time` shown in a `datetime-local` input (local time). */
function localDateTime(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}${
    date.getSeconds() ? `:${pad(date.getSeconds())}` : ""
  }`;
}

/** A `datetime-local` value as the RFC 3339 `date-time` the schema asks for. */
function rfc3339(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().replace(/\.000Z$/, "Z");
}

/** "Allowed file types: .stl, .3mf, or .step" */
function allowedTypes(accept: readonly string[] | undefined) {
  const types = (accept ?? []).filter((value) => value.trim()).slice(0, 16);
  if (!types.length) return undefined;
  try {
    return new Intl.ListFormat("en", {
      style: "long",
      type: "disjunction",
    }).format(types);
  } catch {
    return types.join(", ");
  }
}

/** Controls are shared across legacy/MRTR; the request controller owns receipts and answers. */
export function PluginFormFields({
  requestId,
  plan,
  values,
  errors,
  disabled = false,
  ports = {},
  only,
  onChange,
}: {
  requestId: string;
  plan: PluginFormPlan;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  disabled?: boolean;
  ports?: PluginFormPorts;
  /** One question at a time (the composer card); all fields when absent. */
  only?: string;
  onChange: (name: string, value: unknown) => void;
}) {
  const visible = plan.fields
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => only === undefined || entry.name === only);
  return (
    <div className="min-w-0 space-y-6">
      {visible.map(({ name, field, required, index }) => (
        <PluginFormField
          key={JSON.stringify([requestId, name])}
          name={name}
          field={field}
          required={required}
          id={`plugin-form-field-${index}`}
          value={values[name]}
          error={errors[name]}
          disabled={disabled}
          ports={ports}
          change={(value) => onChange(name, value)}
        />
      ))}
    </div>
  );
}
function PluginFormField({
  name,
  field,
  required,
  id,
  value,
  error,
  disabled,
  ports,
  change,
}: {
  name: string;
  field: PluginFormPlan["fields"][number]["field"];
  required: boolean;
  id: string;
  value: unknown;
  error?: string;
  disabled: boolean;
  ports: PluginFormPorts;
  change: (value: unknown) => void;
}) {
  const input = pluginFormResources(field);
  const string =
    field.type === "string"
      ? field
      : field.type === "array"
      ? field.items
      : undefined;
  const suggestions =
    string && "x-openai-suggestions" in string
      ? string["x-openai-suggestions"]
      : undefined;
  const richOptions = pluginFormOptions(field);
  const [custom, setCustom] = useState("");
  const [other, setOther] = useState(() =>
    typeof value === "string" &&
    !suggestions?.some((option) => option.const === value)
      ? value
      : "",
  );
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [operationError, setOperationError] = useState<string>();
  const [preview, setPreview] = useState<ReactNode>();
  const generation = useRef(0);
  const active = useRef<AbortController | undefined>(undefined);
  const release = useRef<(() => void) | undefined>(undefined);
  const dropPreview = () => {
    const previous = release.current;
    release.current = undefined;
    try {
      previous?.();
      return true;
    } catch {
      return false;
    }
  };
  useEffect(
    () => () => {
      generation.current++;
      active.current?.abort();
      dropPreview();
    },
    [],
  );
  useEffect(() => {
    if (disabled) {
      generation.current++;
      active.current?.abort();
      setPending(false);
      dropPreview();
      setPreview(undefined);
    }
  }, [disabled]);
  const perform = async (operation: (signal: AbortSignal) => Promise<void>) => {
    active.current?.abort();
    const abort = new AbortController();
    active.current = abort;
    const current = ++generation.current;
    setPending(true);
    setOperationError(undefined);
    try {
      await waitForPluginOperation(abort.signal, () => operation(abort.signal));
    } catch (error) {
      if (!abort.signal.aborted && current === generation.current)
        setOperationError(
          error instanceof PluginDescribedError
            ? error.message
            : "The host could not complete this request. Try again.",
        );
    } finally {
      if (current === generation.current) setPending(false);
    }
  };
  const choose = () => {
    if (disabled || pending || !input || !ports.chooseResources) return;
    void perform(async (signal) => {
      const uris = await ports.chooseResources!(
        input.userOptions ?? { kind: "file" },
        signal,
        { field: name, multiple: field.type === "array" },
      );
      signal.throwIfAborted();
      if (
        !Array.isArray(uris) ||
        uris.length > 128 ||
        uris.some((uri) => typeof uri !== "string" || !uri.trim())
      )
        throw new Error("Invalid resource selection");
      if (field.type === "string" && uris.length > 1)
        throw new Error("Select one resource");
      // Closing the native picker is not a request to remove the existing
      // selection. Explicit removal has its own control.
      if (!uris.length) return;
      change(
        field.type === "array"
          ? [...new Set([...(Array.isArray(value) ? value : []), ...uris])]
          : uris[0],
      );
    });
  };
  const openPreview = (target: PluginFormPreview) => {
    if (disabled || pending || !ports.preview) return;
    void perform(async (signal) => {
      const opened = await ports.preview!(target, signal);
      if (signal.aborted) {
        opened.release();
        signal.throwIfAborted();
      }
      if (!dropPreview()) {
        opened.release();
        throw new Error("Preview cleanup failed");
      }
      release.current = opened.release;
      setPreview(opened.content);
    });
  };
  const primitive = parseElicitationSchema({
    type: "object",
    required: required ? [name] : [],
    properties: { [name]: field },
  })[0]!;
  const title = field.title ?? name;
  const multiple = field.type === "array";
  const list = Array.isArray(value) ? (value as unknown[]) : [];
  const busy = disabled || pending;
  const choiceOf = (option: {
    const: string;
    title: string;
    description?: string;
    "x-openai-thumbnail"?: unknown;
    "x-openai-preview"?: unknown;
  }): Choice => ({
    value: option.const,
    label: option.title,
    description: option.description,
    thumbnail: option["x-openai-thumbnail"] ?? option["x-openai-preview"],
  });
  /** Toggle an offered value in place, keeping the declared semantics. */
  const toggleOffered = (choice: Choice, checked: boolean) =>
    change(
      multiple
        ? checked
          ? list.filter((item) => item !== choice.value)
          : [...list, choice.value]
        : checked
        ? undefined
        : choice.value,
    );

  // Titled choices, plain enums and suggested values share one row list.
  const offered: Choice[] | undefined = input
    ? undefined
    : richOptions.length
    ? richOptions.map(choiceOf)
    : suggestions?.length
    ? suggestions.map(choiceOf)
    : (primitive.kind === "enum" || primitive.kind === "multi-enum") &&
      primitive.options?.length
    ? primitive.options.map((option) => ({
        value: option.value,
        label: option.label,
      }))
    : undefined;
  // Suggested values are offered rows, so only a bare string array is free.
  const freeArray =
    pluginFormFreeArray(field) &&
    field.type === "array" &&
    !suggestions?.length;
  const typedEntries = multiple && (freeArray || !!suggestions?.length);
  const offeredValues = new Set(offered?.map((choice) => choice.value) ?? []);
  // Values the user typed stay in the same list, checked; unchecking removes
  // that one entry.
  const typedRows: Choice[] = typedEntries
    ? list.flatMap((item) =>
        typeof item === "string" && (freeArray || !offeredValues.has(item))
          ? [{ value: item, label: item, custom: true }]
          : [],
      )
    : [];
  const rows = offered || typedEntries ? [...(offered ?? []), ...typedRows] : [];
  const images = rows.some((choice) => choice.thumbnail !== undefined);
  const canAddEmpty = !(
    string &&
    "minLength" in string &&
    (string.minLength ?? 0) > 0
  );
  const addTyped = () => {
    if (busy || (!custom && !canAddEmpty)) return;
    change([...list, custom]);
    setCustom("");
  };
  const inlineAdd = typedEntries ? (
    <div className="flex items-center gap-3 px-2 py-1">
      <Plus aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <Input
        id={id}
        value={custom}
        disabled={busy}
        placeholder={freeArray ? "Add a value" : "Add your own"}
        aria-label={`Add ${title}`}
        className="h-8"
        onChange={(event) => setCustom(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            addTyped();
          }
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        disabled={busy || (!custom && !canAddEmpty)}
        onClick={addTyped}
      >
        Add
      </Button>
    </div>
  ) : !multiple && suggestions?.length ? (
    // A single text answer: pick a suggestion or type your own.
    <div className="flex items-center gap-3 px-2 py-1">
      <KeyMark
        index={9}
        checked={
          typeof value === "string" &&
          !!other &&
          value === other &&
          !offeredValues.has(value)
        }
      />
      <Input
        id={id}
        value={other}
        disabled={busy}
        placeholder="Type your own"
        aria-label={`Other ${title}`}
        className="h-8"
        onChange={(event) => {
          setOther(event.target.value);
          change(event.target.value);
        }}
      />
    </div>
  ) : null;

  const resourceSection = input
    ? (() => {
        const upload =
          (input.userOptions !== undefined || input.selection === "implicit") &&
          !!ports.chooseResources;
        const directory = input.userOptions?.kind === "directory";
        const resourceImages = input.options.some(
          (resource) => resource._meta?.["openai/thumbnail"] !== undefined,
        );
        const extra = (
          multiple
            ? list
            : typeof value === "string" && value
            ? [value]
            : []
        ).filter(
          (uri): uri is string =>
            typeof uri === "string" &&
            !input.options.some((option) => option.uri === uri),
        );
        // Implicit selection is add/remove: what remains is the answer, so a
        // removed option leaves the list instead of showing unchecked.
        // Explicit selection is select/deselect over every option.
        const implicit = multiple && input.selection === "implicit";
        const shown = input.options
          .map((resource, index) => ({ resource, index }))
          .filter(({ resource }) => !implicit || list.includes(resource.uri));
        const total = shown.length + extra.length;
        const collapsible = total > RESOURCE_ROW_LIMIT;
        return (
          <>
            <div
              role={multiple ? "group" : "radiogroup"}
              aria-label={title}
              className={cn(
                "min-w-0",
                expanded
                  ? "grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-3"
                  : "flex snap-x gap-3 overflow-x-auto pb-1",
              )}
            >
              {upload && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={choose}
                  className="flex min-h-24 w-28 shrink-0 snap-start flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-muted/40 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
                >
                  <Upload aria-hidden="true" className="size-4" />
                  {directory ? "Choose folder" : "Choose files"}
                </button>
              )}
              {shown.map(({ resource, index }) => {
                const target = pluginFormPreview(resource);
                const label = resource.title ?? resource.name;
                const checked = multiple
                  ? list.includes(resource.uri)
                  : value === resource.uri;
                const body = (
                  <>
                    {resourceImages ? (
                      <Thumbnail
                        value={resource._meta?.["openai/thumbnail"]}
                        size="card"
                      />
                    ) : null}
                    <span className="flex min-w-0 items-center gap-1.5 px-2 py-1.5 text-xs">
                      {!resourceImages && (
                        <FileText
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      )}
                      <span className="truncate" title={label}>
                        {label}
                      </span>
                    </span>
                  </>
                );
                return (
                  <div
                    key={index}
                    data-resource-option={resource.uri}
                    className={cn(
                      "relative shrink-0 snap-start",
                      expanded ? "min-w-0" : "w-32",
                    )}
                  >
                    {implicit ? (
                      <div className="block w-full min-w-0 rounded-lg border border-foreground text-left ring-1 ring-foreground">
                        {body}
                      </div>
                    ) : (
                      <button
                        type="button"
                        role={multiple ? "checkbox" : "radio"}
                        aria-checked={checked}
                        aria-label={label}
                        disabled={busy}
                        data-choice-key={index < 9 ? index + 1 : undefined}
                        onClick={() =>
                          toggleOffered(
                            { value: resource.uri, label },
                            checked,
                          )
                        }
                        className={cn(
                          "block w-full min-w-0 rounded-lg border text-left transition-colors disabled:opacity-60",
                          checked
                            ? "border-foreground ring-1 ring-foreground"
                            : "border-border hover:bg-muted/60",
                        )}
                      >
                        {body}
                      </button>
                    )}
                    {!implicit && multiple && checked && (
                      <span className="pointer-events-none absolute left-1.5 top-1.5">
                        <CheckMark checked />
                      </span>
                    )}
                    {implicit && (
                      <Button
                        type="button"
                        size="icon"
                        variant="secondary"
                        className="absolute right-1 top-1 size-6"
                        disabled={busy}
                        aria-label={`Remove ${label}`}
                        onClick={() =>
                          change(list.filter((item) => item !== resource.uri))
                        }
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                    {target && ports.preview && (
                      <Button
                        type="button"
                        size="icon"
                        variant="secondary"
                        className={cn(
                          "absolute top-1 size-6",
                          implicit ? "right-8" : "right-1",
                        )}
                        disabled={busy}
                        aria-label={`Preview ${label}`}
                        onClick={() => openPreview(target)}
                      >
                        <Eye className="size-3.5" />
                      </Button>
                    )}
                  </div>
                );
              })}
              {extra.map((uri, index) => {
                const label = ports.resourceLabel?.(uri) ?? uri;
                return (
                  <div
                    key={`added:${index}`}
                    className={cn(
                      "relative shrink-0 snap-start",
                      expanded ? "min-w-0" : "w-32",
                    )}
                  >
                    <div className="flex min-h-24 w-full min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-foreground px-2 text-xs ring-1 ring-foreground">
                      {directory ? (
                        <Folder aria-hidden="true" className="size-4" />
                      ) : (
                        <FileText aria-hidden="true" className="size-4" />
                      )}
                      <span className="w-full truncate text-center" title={label}>
                        {label}
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      className="absolute right-1 top-1 size-6"
                      disabled={busy}
                      aria-label={`Remove ${label}`}
                      onClick={() =>
                        change(
                          multiple
                            ? list.filter((item) => item !== uri)
                            : undefined,
                        )
                      }
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
            {collapsible && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => setExpanded((open) => !open)}
              >
                <LayoutGrid aria-hidden="true" className="size-3.5" />
                {expanded ? "Show less" : "View all"}
              </Button>
            )}
          </>
        );
      })()
    : null;

  const accept = input ? allowedTypes(input.userOptions?.accept) : undefined;
  // The picker edits local wall time; a date-time answer is RFC 3339.
  const dateTime =
    primitive.kind === "string" && primitive.format === "date-time";
  const boolean = !input && !offered && primitive.kind === "boolean";
  return (
    <div
      data-plugin-form-field={name}
      className="min-w-0 space-y-2 [overflow-wrap:anywhere]"
      aria-describedby={error ? `${id}-error` : undefined}
    >
      {!boolean && (
        <Label htmlFor={id}>
          {title}
          {required && <span className="text-destructive"> *</span>}
        </Label>
      )}
      {field.description && !boolean && (
        <p className="max-h-32 overflow-y-auto text-xs text-muted-foreground">
          {field.description}
        </p>
      )}
      {accept && (
        <p className="text-xs text-muted-foreground">
          Allowed file types: {accept}
        </p>
      )}
      {resourceSection}
      {!input && rows.length ? (
        <ChoiceRows
          choices={rows}
          images={images}
          selected={value}
          multiple={multiple}
          disabled={busy}
          label={title}
          onToggle={(choice, index, checked) => {
            if (choice.custom) {
              // Remove exactly this typed entry, even when it repeats.
              const position = index - (rows.length - typedRows.length);
              let seen = -1;
              change(
                list.filter((item) => {
                  const typed =
                    typeof item === "string" &&
                    (freeArray || !offeredValues.has(item));
                  if (typed) seen++;
                  return !(typed && seen === position);
                }),
              );
              return;
            }
            if (!multiple && suggestions?.length) setOther("");
            toggleOffered(choice, checked);
          }}
        >
          {inlineAdd}
        </ChoiceRows>
      ) : !input && typedEntries ? (
        <ChoiceRows
          choices={[]}
          images={false}
          selected={value}
          multiple
          disabled={busy}
          label={title}
          onToggle={() => {}}
        >
          {inlineAdd}
        </ChoiceRows>
      ) : boolean ? (
        <button
          type="button"
          role="checkbox"
          id={id}
          aria-checked={value === true}
          disabled={busy}
          onClick={() => change(value !== true)}
          className="-mx-1 flex w-full min-w-0 items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted/60 disabled:opacity-60"
        >
          <CheckMark checked={value === true} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm">
              {title}
              {required && <span className="text-destructive"> *</span>}
            </span>
            {field.description && (
              <span className="block text-xs text-muted-foreground">
                {field.description}
              </span>
            )}
          </span>
        </button>
      ) : !input && !offered ? (
        <SchemaFormFieldControl
          field={primitive}
          id={id}
          value={dateTime ? localDateTime(value) : value}
          error={error}
          disabled={busy}
          onChange={dateTime ? (next) => change(rfc3339(next)) : change}
        />
      ) : null}
      {preview && (
        <div className="rounded-md border border-border p-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              dropPreview();
              setPreview(undefined);
            }}
          >
            Close preview
          </Button>
          {preview}
        </div>
      )}
      {pending && (
        <p role="status" className="text-xs text-muted-foreground">
          Waiting for the host…
        </p>
      )}
      {operationError && (
        <p role="alert" className="text-xs text-destructive">
          {operationError}
        </p>
      )}
      {error && (
        <p role="alert" id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
