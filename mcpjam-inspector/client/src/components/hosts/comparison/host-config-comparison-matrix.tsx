import { useMemo, useState } from "react";
import { Info, TrendingUp, TriangleAlert, X } from "lucide-react";
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
import { StyleColorSwatch } from "@/components/hosts/style-token-swatch";
import { getScenarioHostLogo } from "@/lib/scenario-client-style";
import type { HostThemeMode } from "@/lib/client-styles";
import {
  fieldDiverges,
  groupHostConfigFields,
  HOST_CONFIG_FIELDS,
  NOT_SUPPORTED,
  type HostComparisonSubject,
  type StyleVariableByTheme,
  type HostConfigFieldDef,
} from "@/lib/host-config-field-schema";
import { SupportChip } from "./support-chip";
import { PRESET_HOST_ID_PREFIX } from "./host-compare-presets";
import { buildHostVerifySearch } from "../host-verify-deep-link";
import {
  cellPassesSupportFilter,
  computeVisibleFieldIds,
  getCapabilityCaveats,
  getSupportLevel,
  rowCoverage,
  type SupportFilterMode,
  type SupportLevel,
} from "./support-level";
import {
  formatVerifiedAt,
  isVerifiedAtStale,
  STALE_VERIFIED_AT_LABEL,
} from "../verified-at";

interface HostConfigComparisonMatrixProps {
  subjects: ReadonlyArray<HostComparisonSubject>;
  fields?: ReadonlyArray<HostConfigFieldDef>;
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
  /**
   * When set, each column header gets a "Verify against your server" action
   * deep-linking to `<verifyBaseUrl>/hosts?template=<templateId>` — the hosted
   * app opens (or creates) that client's host. Used only on the public caniuse
   * surface (`presetOnly`), where every column is a synthetic preset host.
   */
  verifyBaseUrl?: string;
  /** Template ids that are visible for reference but cannot be verified yet. */
  disabledVerifyTemplateIds?: ReadonlySet<string>;
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
  fields = HOST_CONFIG_FIELDS,
  divergingOnly = false,
  supportFilter = "all",
  searchQuery = "",
  showDescriptions = false,
  onRemoveHost,
  themeMode = "light",
  mobileOptimized = false,
  verifyBaseUrl,
  disabledVerifyTemplateIds,
}: HostConfigComparisonMatrixProps) {
  const groups = useMemo(() => groupHostConfigFields(fields), [fields]);
  const configs = useMemo(() => subjects.map((s) => s.config), [subjects]);
  const showVerifiedAtRow = verifyBaseUrl !== undefined;

  const divergingIds = useMemo(() => {
    const set = new Set<string>();
    for (const field of fields) {
      if (fieldDiverges(field, configs)) set.add(field.id);
    }
    return set;
  }, [configs, fields]);
  const useCellSupportFilter =
    searchQuery.trim().length > 0 && supportFilter !== "all";

  // Rows surviving the diverging toggle, support filter, and search query.
  // Computed once here so the section/subsection passes stay in lockstep, and
  // shared with the container's result count via `computeVisibleFieldIds`.
  const visibleFieldIds = useMemo(
    () =>
      computeVisibleFieldIds({
        fields,
        configs,
        divergingOnly,
        supportFilter: useCellSupportFilter ? "all" : supportFilter,
        searchQuery,
      }),
    [
      fields,
      configs,
      divergingOnly,
      supportFilter,
      searchQuery,
      useCellSupportFilter,
    ],
  );
  const visibleFields = useMemo(
    () => fields.filter((field) => visibleFieldIds.has(field.id)),
    [fields, visibleFieldIds],
  );
  const displaySubjects = useMemo(() => {
    if (!useCellSupportFilter) return subjects;
    return subjects.filter((subject) =>
      visibleFields.some((field) =>
        cellPassesSupportFilter(field, subject.config, supportFilter),
      ),
    );
  }, [subjects, supportFilter, useCellSupportFilter, visibleFields]);

  if (subjects.length === 0) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center text-sm text-muted-foreground">
        No clients to compare. Create at least one client in this project.
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

  if (displaySubjects.length === 0) {
    return (
      <div className="flex h-full min-h-[160px] items-center justify-center rounded-xl border border-border bg-card text-sm text-muted-foreground">
        No clients match the current search and filters.
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      data-testid="compare-matrix"
      className={cn(
        // framer-motion leaves a non-`none` `transform` on this element even at
        // rest. The scroll box below MUST be a direct child of it (not several
        // levels further out): some browsers mis-constrain `position: sticky`
        // to the nearest *transformed* ancestor's box rather than the true
        // scrolling ancestor when the two don't coincide, which un-pins the
        // header. Keeping them coincident here is what the original PR shipped
        // with.
        //
        // `max-h-full` (not `flex-1`): the parent div hands us the space left
        // below the search/selector row as a definite height via its own
        // flex-1, and we only want to cap ourselves at that — not force-fill
        // it. `flex-1` always grows to the full available height regardless of
        // content, so filtering the table down to a couple of rows left a
        // dead band of `bg-card` the same size as the original page-gap bug,
        // just moved inside the border. `max-h-full` lets a short result hug
        // its own content and only claims the full height when the table
        // actually needs it.
        //
        // No `min-h-*` either: it would re-floor the card at a fixed height and
        // put the dead band back for a one- or two-row result. Nothing renders
        // here that needs a floor — every empty case returns above this.
        "flex max-h-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_0_rgba(0,0,0,0.02),0_12px_30px_-18px_rgba(0,0,0,0.18)]",
        mobileOptimized && "max-w-full",
      )}
    >
      <div
        data-testid="compare-matrix-scroll"
        className={cn(
          // No `flex-1` here either — this box shrinks to fit inside the
          // card's (possibly content-hugged) height, which is what lets
          // `overflow-auto` show a scrollbar only once the table actually
          // exceeds that height, not unconditionally.
          "min-h-0 overflow-auto",
          mobileOptimized && "max-w-full [-webkit-overflow-scrolling:touch]",
        )}
      >
        <table
          className={cn(
            "border-collapse text-center text-[13px]",
            mobileOptimized ? "w-max min-w-full" : "w-full",
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
            {displaySubjects.map((s) => (
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
              <th className="sticky left-0 top-0 z-30 bg-card border-b border-border px-3 py-3 text-left after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border after:content-[''] sm:px-5 sm:py-4">
                <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                  Field
                </span>
              </th>
              {displaySubjects.map((s) => (
                <HostColumnHeader
                  key={s.hostId}
                  subject={s}
                  onRemove={onRemoveHost}
                  themeMode={themeMode}
                  verifyBaseUrl={verifyBaseUrl}
                  disabledVerifyTemplateIds={disabledVerifyTemplateIds}
                />
              ))}
            </tr>
          </thead>

          <tbody>
            {showVerifiedAtRow ? (
              <VerifiedAtRow
                subjects={displaySubjects}
                mobileOptimized={mobileOptimized}
              />
            ) : null}
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
                  subjects={displaySubjects}
                  coverageSubjects={subjects}
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

function VerifiedAtRow({
  subjects,
  mobileOptimized,
}: {
  subjects: ReadonlyArray<HostComparisonSubject>;
  mobileOptimized: boolean;
}) {
  return (
    <tr className="border-b border-border bg-card">
      <td
        className={cn(
          "sticky left-0 z-10 bg-card px-3 py-1.5 text-left after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border after:content-[''] sm:px-5",
          mobileOptimized && "min-w-0",
        )}
      >
        <span className="text-[12px] font-medium leading-tight text-muted-foreground">
          Verified at
        </span>
      </td>
      {subjects.map((subject) => (
        <td
          key={subject.hostId}
          className="min-w-[220px] border-l border-border px-3 py-1.5 text-center align-top sm:px-4"
        >
          <div className="flex min-h-5 items-center justify-center">
            {isVerifiedAtStale(subject.verifiedAt) ? (
              <span className="inline-flex items-center gap-1 whitespace-nowrap text-[12px] leading-tight text-muted-foreground">
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                {STALE_VERIFIED_AT_LABEL}
              </span>
            ) : (
              <span className="text-[12px] tabular-nums text-muted-foreground">
                {formatVerifiedAt(subject.verifiedAt)}
              </span>
            )}
          </div>
        </td>
      ))}
    </tr>
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
  coverageSubjects: ReadonlyArray<HostComparisonSubject>;
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
  coverageSubjects,
  divergingIds,
  visibleFieldIds,
  showDescriptions,
  mobileOptimized,
}: SectionRowsProps) {
  const colSpan = subjects.length + 1;
  return (
    <>
      <tr>
        {/* Label lives in its own first-column cell so `sticky left-0` can pin
            it — a colSpan cell spans the whole table and never sticks. */}
        <th
          scope="colgroup"
          className="sticky left-0 z-20 border-y border-border bg-muted px-3 py-1 text-left after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border after:content-[''] sm:px-5"
        >
          <motion.div
            className="flex items-baseline gap-2"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{
              delay: 0.08 + index * 0.07,
              duration: 0.4,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <span className="text-[13px] font-medium tracking-tight">
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
          </motion.div>
        </th>
        <td colSpan={colSpan - 1} className="border-y border-border bg-muted" />
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
            coverageSubjects={coverageSubjects}
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
  coverageSubjects,
  divergingIds,
  colSpan,
  showDescriptions,
  mobileOptimized,
}: {
  label: string;
  fields: ReadonlyArray<HostConfigFieldDef>;
  subjects: ReadonlyArray<HostComparisonSubject>;
  coverageSubjects: ReadonlyArray<HostComparisonSubject>;
  divergingIds: ReadonlySet<string>;
  colSpan: number;
  showDescriptions: boolean;
  mobileOptimized: boolean;
}) {
  return (
    <>
      <tr>
        <td className="sticky left-0 z-10 border-b border-border bg-card px-3 py-1.5 text-left text-[10px] uppercase tracking-wider text-muted-foreground after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border after:content-[''] sm:px-5">
          {label}
        </td>
        <td colSpan={colSpan - 1} className="border-b border-border bg-card" />
      </tr>
      {fields.map((field) => (
        <FieldRow
          key={field.id}
          field={field}
          subjects={subjects}
          coverageSubjects={coverageSubjects}
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
  coverageSubjects,
  diverges,
  showDescriptions,
  mobileOptimized,
}: {
  field: HostConfigFieldDef;
  subjects: ReadonlyArray<HostComparisonSubject>;
  coverageSubjects: ReadonlyArray<HostComparisonSubject>;
  diverges: boolean;
  showDescriptions: boolean;
  mobileOptimized: boolean;
}) {
  // caniuse "global support" equivalent — only meaningful when comparing ≥2 hosts.
  const coverage =
    coverageSubjects.length >= 2
      ? rowCoverage(
          field,
          coverageSubjects.map((s) => s.config),
        )
      : null;
  const labelClassName = cn(
    "text-[13px] font-medium leading-tight text-foreground",
    mobileOptimized && "min-w-0 break-words",
  );
  return (
    <tr className="border-b border-border last:border-b-0">
      {/* NOTE: no `relative` here — `cn` (tailwind-merge) treats it as
          conflicting with `sticky` and would strip the sticky positioning.
          `sticky` already anchors the absolute diverge gutter below. */}
      <td className="sticky left-0 z-10 bg-card px-3 py-2.5 text-left after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border after:content-[''] sm:px-5">
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
            mobileOptimized && "min-w-0",
          )}
        >
          <span className={labelClassName}>{field.label}</span>
          {coverage && (
            <span
              className="text-[10.5px] text-muted-foreground tabular-nums"
              title={`Supported by ${coverage.supported} of ${coverage.total} clients`}
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
          <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
            {field.description}
          </div>
        )}
      </td>
      {subjects.map((s) => (
        <td
          key={s.hostId}
          className="border-l border-border px-3 py-2.5 text-center align-top sm:px-4"
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

  // An explicit "we probed this host and it does not send this" — distinct
  // from the em dash below, which means nobody has looked.
  if (value === NOT_SUPPORTED) {
    return <SupportChip level="unsupported" label="Not supported" />;
  }

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
        <span className="inline-flex items-center justify-center gap-2">
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
            mobileOptimized && "break-words",
          )}
        >
          {String(value)}
        </span>
      );
    }

    case "mode-set": {
      const present = new Set(Array.isArray(value) ? (value as string[]) : []);
      return (
        <span className="inline-flex flex-wrap items-center justify-center gap-1">
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

    case "style-variable": {
      const v = value as StyleVariableByTheme;
      // Colors get a chip: two hex strings are only comparable at a glance
      // once you can see them. Sizes, radii and shadows have nothing to show.
      const isColor = field.label.startsWith("--color-");
      // One string answering both themes renders bare — labelling it "light"
      // and "dark" twice would imply a distinction the host does not make.
      // A `light-dark(…)` value is NOT this case: it is decoded upstream into
      // the pair below, so the notation a host happens to use never changes
      // the shape of its cell.
      // Everything centers on the cell's own axis: each theme block spans the
      // full cell (`w-full`), so LIGHT and DARK center over the same width
      // and therefore line up with each other AND with the same rows in every
      // other column. Sizing the blocks to their own content instead makes
      // each label drift to wherever its value happens to be wide.
      if ("same" in v) {
        return (
          <span className="inline-flex max-w-full items-center justify-center gap-1.5">
            {isColor ? <StyleColorSwatch value={v.same} /> : null}
            <span className="min-w-0 font-mono text-[12px] break-all">
              {v.same}
            </span>
          </span>
        );
      }
      return (
        <span className="flex w-full flex-col gap-1.5" title={v.raw}>
          {(["light", "dark"] as const).map((theme) => (
            // `items-center` centers the theme label over the swatch+value row
            // it names; the row itself keeps its own left edge, so the two
            // themes still line up with each other for reading down the cell.
            <span
              key={theme}
              className="flex w-full flex-col items-center gap-0.5"
            >
              <span className="text-[10px] uppercase leading-none tracking-wide text-muted-foreground/60">
                {theme}
              </span>
              {v[theme] === undefined ? (
                <span className="text-[12px] text-muted-foreground/60">—</span>
              ) : (
                <span className="flex max-w-full items-center justify-center gap-1.5">
                  {isColor ? <StyleColorSwatch value={v[theme]} /> : null}
                  <span className="min-w-0 font-mono text-[12px] break-all">
                    {v[theme]}
                  </span>
                </span>
              )}
            </span>
          ))}
        </span>
      );
    }

    case "string-long": {
      const s = String(value);
      const firstLine = s.split("\n", 1)[0] ?? "";
      return (
        <div className="flex flex-col items-center gap-0.5 text-center">
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
            mobileOptimized && "break-words",
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
        <div className="flex flex-col items-center gap-0.5 text-center font-mono text-[11.5px] leading-snug">
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
  verifyBaseUrl,
  disabledVerifyTemplateIds,
}: {
  subject: HostComparisonSubject;
  onRemove?: (hostId: string) => void;
  themeMode: HostThemeMode;
  verifyBaseUrl?: string;
  disabledVerifyTemplateIds?: ReadonlySet<string>;
}) {
  const logoSrc = getScenarioHostLogo(
    subject.hostStyle,
    subject.config.chatUiOverride,
    themeMode,
  );
  const reduceMotion = useReducedMotion();
  const verifyHref = buildVerifyHref(
    verifyBaseUrl,
    subject.hostId,
    disabledVerifyTemplateIds,
  );

  return (
    <th className="sticky top-0 z-20 border-b border-l border-border bg-card px-3 py-3 text-center align-top sm:px-4 sm:py-4">
      <motion.div
        key={subject.hostId}
        className={cn(
          "relative flex items-start justify-center gap-2",
          onRemove && "pl-5",
        )}
        initial={reduceMotion ? false : { opacity: 0, x: -6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      >
        {onRemove ? (
          <motion.button
            type="button"
            aria-label={`Remove ${subject.hostName} from comparison`}
            data-testid={`host-compare-remove-${subject.hostId}`}
            className="absolute left-0 top-0 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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
          className="min-w-0 max-w-[160px] truncate text-center text-[14px] font-medium leading-tight"
          title={subject.hostName}
        >
          {subject.hostName}
        </div>
        {verifyHref ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={verifyHref}
                data-testid={`host-compare-verify-${subject.hostId}`}
                aria-label={`Verify ${subject.hostName} against your server`}
                className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <TrendingUp className="size-3.5" />
              </a>
            </TooltipTrigger>
            <TooltipContent side="top" variant="muted">
              Verify against your server
            </TooltipContent>
          </Tooltip>
        ) : null}
      </motion.div>
    </th>
  );
}

/**
 * Deep-link a preset column to the hosted app's "verify" entry point:
 * `<base>/hosts?template=claude`. Only preset columns carry a template id;
 * a non-preset host (shouldn't happen on the public surface) falls back to
 * the bare base URL. Returns null when verification is disabled.
 */
function buildVerifyHref(
  baseUrl: string | undefined,
  hostId: string,
  disabledVerifyTemplateIds?: ReadonlySet<string>,
): string | null {
  if (!baseUrl) return null;
  if (!hostId.startsWith(PRESET_HOST_ID_PREFIX)) return baseUrl;
  const templateId = hostId.slice(PRESET_HOST_ID_PREFIX.length);
  if (disabledVerifyTemplateIds?.has(templateId)) return null;
  return `${baseUrl}/hosts?${buildHostVerifySearch(templateId, "behavior")}`;
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
          className="text-center text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          "max-h-[400px] overflow-auto p-3",
          mobileOptimized
            ? "max-w-[calc(100vw-24px)] sm:max-w-[520px]"
            : "max-w-[520px]",
        )}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
