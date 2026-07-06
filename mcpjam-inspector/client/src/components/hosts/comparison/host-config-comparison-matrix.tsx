import { useMemo, useState } from "react";
import { Info, X } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { getChatboxHostLogo } from "@/lib/chatbox-client-style";
import type { HostThemeMode } from "@/lib/client-styles";
import {
  fieldDiverges,
  groupHostConfigFields,
  HOST_CONFIG_FIELDS,
  type HostComparisonSubject,
  type HostConfigFieldDef,
} from "@/lib/host-config-field-schema";
import { SupportChip } from "./support-chip";
import {
  computeVisibleFieldIds,
  getCapabilityCaveats,
  getSupportLevel,
  rowCoverage,
  type SupportFilterMode,
  type SupportLevel,
} from "./support-level";

interface HostConfigComparisonMatrixProps {
  subjects: ReadonlyArray<HostComparisonSubject>;
  /** When true, hide rows whose value is identical across every host. */
  divergingOnly?: boolean;
  /** caniuse-style row filter by aggregate support level. Default `"all"`. */
  supportFilter?: SupportFilterMode;
  /** Free-text query; matches field label / description / subsection. */
  searchQuery?: string;
  /**
   * When true, render each field's description inline beneath its label.
   * When false (default), the description moves into a hover `i` affordance
   * so rows stay compact and scannable.
   */
  showDescriptions?: boolean;
  /** Remove a column; omitted when only one host remains. */
  onRemoveHost?: (hostId: string) => void;
  themeMode?: HostThemeMode;
  mobileOptimized?: boolean;
}

/**
 * WPT-style host comparison surface, but caniuse semantically: every row
 * is a hostConfig field, every column is a saved host, every cell shows
 * the actual stored value. Sections mirror the focus-dialog tabs
 * (Agent · MCP Protocol · Apps) via `HOST_CONFIG_SECTIONS`.
 *
 * Pure presentation — data fetching lives in the container.
 */
export function HostConfigComparisonMatrix({
  subjects,
  divergingOnly = false,
  supportFilter = "all",
  searchQuery = "",
  showDescriptions = false,
  onRemoveHost,
  themeMode = "light",
  mobileOptimized = false,
}: HostConfigComparisonMatrixProps) {
  const groups = useMemo(() => groupHostConfigFields(HOST_CONFIG_FIELDS), []);
  const configs = useMemo(() => subjects.map((s) => s.config), [subjects]);

  const divergingIds = useMemo(() => {
    const set = new Set<string>();
    for (const field of HOST_CONFIG_FIELDS) {
      if (fieldDiverges(field, configs)) set.add(field.id);
    }
    return set;
  }, [configs]);

  // Rows surviving the diverging toggle, support filter, and search query.
  // Computed once here so the section/subsection passes stay in lockstep, and
  // shared with the container's result count via `computeVisibleFieldIds`.
  const visibleFieldIds = useMemo(
    () =>
      computeVisibleFieldIds({
        configs,
        divergingOnly,
        supportFilter,
        searchQuery,
      }),
    [configs, divergingOnly, supportFilter, searchQuery]
  );

  if (subjects.length === 0) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center text-sm text-muted-foreground">
        No hosts to compare. Create at least one host in this project.
      </div>
    );
  }

  if (visibleFieldIds.size === 0) {
    return (
      <div className="flex h-full min-h-[160px] items-center justify-center rounded-xl border border-border bg-card text-sm text-muted-foreground">
        No fields match the current search and filters.
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_0_rgba(0,0,0,0.02),0_12px_30px_-18px_rgba(0,0,0,0.18)]",
        mobileOptimized && "min-w-0 max-w-full"
      )}
    >
      {/* Only the table scrolls horizontally; field column stays sticky. */}
      <div
        className={
          mobileOptimized
            ? "max-w-full overflow-x-auto overflow-y-visible [-webkit-overflow-scrolling:touch]"
            : "overflow-auto"
        }
      >
        <table
          className={cn(
            "border-collapse text-[13px]",
            mobileOptimized ? "w-max min-w-full" : "w-full"
          )}
        >
          <colgroup>
            <col
              className={
                mobileOptimized
                  ? "w-[140px] sm:w-[300px]"
                  : "w-[168px] sm:w-[300px]"
              }
            />
            {subjects.map((s) => (
              <col
                key={s.hostId}
                className={
                  mobileOptimized
                    ? "w-[132px] sm:w-[220px]"
                    : "w-[148px] sm:w-[220px]"
                }
              />
            ))}
          </colgroup>

          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 bg-card border-b border-r border-border px-3 py-3 sm:px-5 sm:py-4 text-left">
                <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                  Field
                </span>
              </th>
              {subjects.map((s) => (
                <HostColumnHeader
                  key={s.hostId}
                  subject={s}
                  onRemove={onRemoveHost}
                  themeMode={themeMode}
                />
              ))}
            </tr>
          </thead>

          <tbody>
            {groups.map((group, groupIndex) => {
              const visibleFieldsInGroup = group.subsections
                .flatMap((sub) => sub.fields)
                .filter((f) => visibleFieldIds.has(f.id));
              if (visibleFieldsInGroup.length === 0) return null;

              const groupDivergeCount = group.subsections
                .flatMap((sub) => sub.fields)
                .filter((f) => divergingIds.has(f.id)).length;

              return (
                <SectionRows
                  key={group.section.id}
                  index={groupIndex}
                  sectionLabel={group.section.label}
                  divergeCount={groupDivergeCount}
                  subsections={group.subsections}
                  subjects={subjects}
                  divergingIds={divergingIds}
                  visibleFieldIds={visibleFieldIds}
                  showDescriptions={showDescriptions}
                  mobileOptimized={mobileOptimized}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}

interface SectionRowsProps {
  index: number;
  sectionLabel: string;
  divergeCount: number;
  subsections: ReadonlyArray<{
    label: string;
    fields: ReadonlyArray<HostConfigFieldDef>;
  }>;
  subjects: ReadonlyArray<HostComparisonSubject>;
  divergingIds: ReadonlySet<string>;
  visibleFieldIds: ReadonlySet<string>;
  showDescriptions: boolean;
  mobileOptimized: boolean;
}

function SectionRows({
  index,
  sectionLabel,
  divergeCount,
  subsections,
  subjects,
  divergingIds,
  visibleFieldIds,
  showDescriptions,
  mobileOptimized,
}: SectionRowsProps) {
  const colSpan = subjects.length + 1;
  return (
    <>
      <tr>
        <th
          colSpan={colSpan}
          scope="colgroup"
          className="sticky top-[64px] z-20 bg-muted border-y border-border px-5 py-2 text-left"
        >
          <motion.div
            className="flex items-baseline gap-3"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{
              delay: 0.08 + index * 0.07,
              duration: 0.4,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <span className="text-[15px] font-medium tracking-tight">
              {sectionLabel}
            </span>
            {divergeCount > 0 && (
              <motion.span
                aria-hidden
                className="inline-block size-1.5 rounded-full bg-primary/70"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{
                  delay: 0.2 + index * 0.07,
                  type: "spring",
                  stiffness: 600,
                  damping: 18,
                }}
              />
            )}
            <span className="ml-auto text-[10.5px] text-muted-foreground tabular-nums">
              {divergeCount} diverging
            </span>
          </motion.div>
        </th>
      </tr>

      {subsections.map((sub) => {
        const fields = sub.fields.filter((f) => visibleFieldIds.has(f.id));
        if (fields.length === 0) return null;
        return (
          <SubsectionRows
            key={`${sectionLabel}-${sub.label}`}
            label={sub.label}
            fields={fields}
            subjects={subjects}
            divergingIds={divergingIds}
            colSpan={colSpan}
            showDescriptions={showDescriptions}
            mobileOptimized={mobileOptimized}
          />
        );
      })}
    </>
  );
}

function SubsectionRows({
  label,
  fields,
  subjects,
  divergingIds,
  colSpan,
  showDescriptions,
  mobileOptimized,
}: {
  label: string;
  fields: ReadonlyArray<HostConfigFieldDef>;
  subjects: ReadonlyArray<HostComparisonSubject>;
  divergingIds: ReadonlySet<string>;
  colSpan: number;
  showDescriptions: boolean;
  mobileOptimized: boolean;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={colSpan}
          className="px-5 pt-5 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground"
        >
          {label}
        </td>
      </tr>
      {fields.map((field) => (
        <FieldRow
          key={field.id}
          field={field}
          subjects={subjects}
          diverges={divergingIds.has(field.id)}
          showDescriptions={showDescriptions}
          mobileOptimized={mobileOptimized}
        />
      ))}
    </>
  );
}

function FieldRow({
  field,
  subjects,
  diverges,
  showDescriptions,
  mobileOptimized,
}: {
  field: HostConfigFieldDef;
  subjects: ReadonlyArray<HostComparisonSubject>;
  diverges: boolean;
  showDescriptions: boolean;
  mobileOptimized: boolean;
}) {
  // caniuse "global support" equivalent — only meaningful when comparing ≥2 hosts.
  const coverage =
    subjects.length >= 2
      ? rowCoverage(
          field,
          subjects.map((s) => s.config)
        )
      : null;
  return (
    <tr className="border-b border-border last:border-b-0">
      <td
        className={cn(
          "sticky left-0 z-10 bg-card border-r border-border px-3 sm:px-5 py-2.5",
          "relative"
        )}
      >
        {diverges && (
          <motion.span
            aria-hidden="true"
            className="absolute left-0 top-0 bottom-0 w-[3px] bg-primary/70 origin-top"
            data-testid={`diverge-gutter-${field.id}`}
            initial={{ scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            transition={{
              duration: 0.45,
              ease: [0.22, 1, 0.36, 1],
            }}
          />
        )}
        <div
          className={cn(
            "flex items-center gap-1.5",
            mobileOptimized && "min-w-0"
          )}
        >
          <span
            className={cn(
              "text-[13px] font-medium leading-tight text-foreground",
              mobileOptimized && "min-w-0 break-words"
            )}
          >
            {field.label}
          </span>
          {coverage && (
            <span
              className="text-[10.5px] text-muted-foreground tabular-nums"
              title={`Supported by ${coverage.supported} of ${coverage.total} hosts`}
              data-testid={`coverage-${field.id}`}
            >
              {coverage.supported}/{coverage.total}
            </span>
          )}
          {field.description && !showDescriptions && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`About ${field.label}`}
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <Info className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                variant="muted"
                className="max-w-[260px] text-left [text-wrap:normal]"
              >
                {field.description}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {field.description && showDescriptions && (
          <div className="text-[11px] text-muted-foreground mt-1 leading-snug">
            {field.description}
          </div>
        )}
      </td>
      {subjects.map((s) => (
        <td
          key={s.hostId}
          className="border-l border-border px-3 sm:px-4 py-2.5 align-top"
        >
          <FieldCell
            field={field}
            subject={s}
            mobileOptimized={mobileOptimized}
          />
        </td>
      ))}
    </tr>
  );
}

function FieldCell({
  field,
  subject,
  mobileOptimized,
}: {
  field: HostConfigFieldDef;
  subject: HostComparisonSubject;
  mobileOptimized: boolean;
}) {
  const value = field.read(subject.config);
  const kind = field.kind;

  // Tri-state and capability fields treat `undefined` as a meaningful value
  // (Auto / not-advertised), so we must NOT short-circuit on undefined for
  // them. Every other kind renders absence as `—`.
  if (
    value === undefined &&
    kind.kind !== "tri-state" &&
    kind.kind !== "capability"
  ) {
    return <span className="text-[12px] text-muted-foreground/60">—</span>;
  }

  switch (kind.kind) {
    case "boolean": {
      const level: SupportLevel = value === true ? "supported" : "neutral";
      return (
        <SupportChip level={level} label={value === true ? "Yes" : "No"} />
      );
    }

    case "tri-state": {
      const level: SupportLevel =
        value === true ? "supported" : value === false ? "neutral" : "partial";
      const label = value === true ? "On" : value === false ? "Off" : "Auto";
      return <SupportChip level={level} label={label} />;
    }

    case "capability": {
      const level = getSupportLevel(field, subject.config) ?? "neutral";
      if (value === undefined || value === null) {
        return <SupportChip level={level} label="Not supported" />;
      }
      const caveats = getCapabilityCaveats(field, subject.config);
      const keys =
        typeof value === "object"
          ? Object.keys(value as Record<string, unknown>)
          : [];
      return (
        <span className="inline-flex items-center gap-2">
          <SupportChip level={level} label="Supported" />
          <CapabilityInfoTooltip
            caveats={caveats}
            value={keys.length > 0 ? value : undefined}
          />
        </span>
      );
    }

    case "number":
      return (
        <span className="font-mono tabular-nums text-[12.5px]">
          {typeof value === "number" ? value.toFixed(2) : String(value)}
        </span>
      );

    case "duration-ms": {
      const ms = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(ms)) {
        return <span className="text-[12px] text-muted-foreground/60">—</span>;
      }
      return (
        <span className="font-mono tabular-nums text-[12.5px]">
          {ms.toLocaleString()} ms
        </span>
      );
    }

    case "enum": {
      if (kind.support) {
        const level = getSupportLevel(field, subject.config) ?? "neutral";
        return <SupportChip level={level} label={String(value)} />;
      }
      return (
        <span
          className={cn(
            "text-[13px] text-foreground",
            mobileOptimized && "break-words"
          )}
        >
          {String(value)}
        </span>
      );
    }

    case "mode-set": {
      const present = new Set(Array.isArray(value) ? (value as string[]) : []);
      return (
        <span className="inline-flex flex-wrap items-center gap-1">
          {kind.modes.map((mode) => (
            <SupportChip
              key={mode}
              level={present.has(mode) ? "supported" : "neutral"}
              label={mode}
            />
          ))}
        </span>
      );
    }

    case "string": {
      const s = String(value);
      if (s.length === 0) {
        return <span className="text-[12px] text-muted-foreground/60">""</span>;
      }
      return <span className="font-mono text-[12px] break-all">{s}</span>;
    }

    case "string-long": {
      const s = String(value);
      const firstLine = s.split("\n", 1)[0] ?? "";
      return (
        <div className="flex flex-col gap-0.5">
          <div className="text-[12px] truncate max-w-[200px]">
            {firstLine || (
              <span className="italic text-muted-foreground">empty</span>
            )}
          </div>
          {s.length > 0 && (
            <ExpandablePreview
              label={`view ${s.length.toLocaleString()} chars`}
              mobileOptimized={mobileOptimized}
            >
              <pre className="whitespace-pre-wrap text-[11.5px] leading-snug font-mono max-w-[480px] max-h-[320px] overflow-auto">
                {s}
              </pre>
            </ExpandablePreview>
          )}
        </div>
      );
    }

    case "string-array": {
      if (!Array.isArray(value))
        return <span className="text-[12px] text-muted-foreground/60">—</span>;
      if (value.length === 0) {
        return (
          <span className="text-[12px] text-muted-foreground/60">[] empty</span>
        );
      }
      return (
        <span
          className={cn(
            "text-[13px] leading-snug text-foreground",
            mobileOptimized && "break-words"
          )}
        >
          {value.join(", ")}
        </span>
      );
    }

    case "object": {
      if (typeof value !== "object" || value === null) {
        return <span className="text-[12px] text-muted-foreground/60">—</span>;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        return (
          <span className="font-mono text-[11px] text-muted-foreground">
            {"{} empty"}
          </span>
        );
      }
      // Nothing hidden: render entries inline. Only genuinely large blobs
      // collapse behind the expand popover.
      const json = JSON.stringify(value);
      if (entries.length > 8 || json.length > 220) {
        const noun = kind.itemNoun ?? "key";
        return (
          <ExpandablePreview
            label={`${entries.length} ${noun}${
              entries.length === 1 ? "" : "s"
            } ›`}
            mobileOptimized={mobileOptimized}
          >
            <pre className="whitespace-pre-wrap text-[11.5px] leading-snug font-mono max-w-[480px] max-h-[320px] overflow-auto">
              {JSON.stringify(value, null, 2)}
            </pre>
          </ExpandablePreview>
        );
      }
      return (
        <div className="flex flex-col gap-0.5 font-mono text-[11.5px] leading-snug">
          {entries.map(([k, v]) => (
            <div key={k} className="break-all">
              <span className="text-muted-foreground">{k}: </span>
              <span className="text-foreground">{formatObjectValue(v)}</span>
            </div>
          ))}
        </div>
      );
    }
  }
}

function CapabilityInfoTooltip({
  caveats,
  value,
}: {
  caveats: ReadonlyArray<string>;
  value?: unknown;
}) {
  const hasCaveats = caveats.length > 0;
  const hasValue = value !== undefined;
  if (!hasCaveats && !hasValue) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Capability details"
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <Info className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        variant="muted"
        className="max-w-[min(360px,calc(100vw-24px))] text-left [text-wrap:normal]"
      >
        <div className="space-y-2">
          {hasCaveats ? (
            <ul className="space-y-1">
              {caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          ) : null}
          {hasValue ? (
            <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-snug">
              {JSON.stringify(value, null, 2)}
            </pre>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function HostColumnHeader({
  subject,
  onRemove,
  themeMode,
}: {
  subject: HostComparisonSubject;
  onRemove?: (hostId: string) => void;
  themeMode: HostThemeMode;
}) {
  const logoSrc = getChatboxHostLogo(
    subject.hostStyle,
    subject.config.chatUiOverride,
    themeMode
  );
  const reduceMotion = useReducedMotion();

  return (
    <th className="sticky top-0 z-20 bg-card border-b border-l border-border px-3 py-3 sm:px-4 sm:py-4 text-left align-top">
      <motion.div
        key={subject.hostId}
        className="flex items-start gap-2"
        initial={reduceMotion ? false : { opacity: 0, x: -6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      >
        {onRemove ? (
          <motion.button
            type="button"
            aria-label={`Remove ${subject.hostName} from comparison`}
            data-testid={`host-compare-remove-${subject.hostId}`}
            className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            onClick={() => onRemove(subject.hostId)}
            whileHover={reduceMotion ? undefined : { scale: 1.15 }}
            whileTap={reduceMotion ? undefined : { scale: 0.85, rotate: 90 }}
            transition={{ type: "spring", stiffness: 520, damping: 24 }}
          >
            <X className="size-3" />
          </motion.button>
        ) : null}
        <img
          src={logoSrc}
          alt=""
          className="mt-0.5 size-4 shrink-0 object-contain"
        />
        <div
          className="min-w-0 font-medium text-[14px] truncate leading-tight"
          title={subject.hostName}
        >
          {subject.hostName}
        </div>
      </motion.div>
    </th>
  );
}

/** Compact one-line rendering of an object entry's value for inline display. */
function formatObjectValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function ExpandablePreview({
  label,
  children,
  mobileOptimized = false,
}: {
  label: string;
  children: React.ReactNode;
  mobileOptimized?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-left text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          "max-h-[400px] overflow-auto p-3",
          mobileOptimized
            ? "max-w-[calc(100vw-24px)] sm:max-w-[520px]"
            : "max-w-[520px]"
        )}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
