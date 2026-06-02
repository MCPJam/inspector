import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { cn } from "@/lib/utils";
import { getChatboxHostLogo } from "@/lib/chatbox-client-style";
import {
  fieldDiverges,
  groupHostConfigFields,
  HOST_CONFIG_FIELDS,
  type HostComparisonSubject,
  type HostConfigFieldDef,
} from "@/lib/host-config-field-schema";

interface HostConfigComparisonMatrixProps {
  subjects: ReadonlyArray<HostComparisonSubject>;
  /** When true, hide rows whose value is identical across every host. */
  divergingOnly?: boolean;
  /** Remove a column; omitted when only one host remains. */
  onRemoveHost?: (hostId: string) => void;
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
  onRemoveHost,
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

  if (subjects.length === 0) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center text-sm text-muted-foreground">
        No hosts to compare. Create at least one host in this project.
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-xl border border-border bg-card">
      <table className="w-full border-collapse text-[13px]">
        <colgroup>
          <col style={{ width: 300 }} />
          {subjects.map((s) => (
            <col key={s.hostId} style={{ width: 220 }} />
          ))}
        </colgroup>

        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-30 bg-card border-b border-r border-border px-5 py-4 text-left">
              <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                Field
              </span>
            </th>
            {subjects.map((s) => (
              <HostColumnHeader
                key={s.hostId}
                subject={s}
                onRemove={onRemoveHost}
              />
            ))}
          </tr>
        </thead>

        <tbody>
          {groups.map((group) => {
            const visibleFieldsInGroup = group.subsections
              .flatMap((sub) => sub.fields)
              .filter((f) => !divergingOnly || divergingIds.has(f.id));
            if (visibleFieldsInGroup.length === 0) return null;

            const groupDivergeCount = group.subsections
              .flatMap((sub) => sub.fields)
              .filter((f) => divergingIds.has(f.id)).length;

            return (
              <SectionRows
                key={group.section.id}
                sectionLabel={group.section.label}
                divergeCount={groupDivergeCount}
                subsections={group.subsections}
                subjects={subjects}
                divergingIds={divergingIds}
                divergingOnly={divergingOnly}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface SectionRowsProps {
  sectionLabel: string;
  divergeCount: number;
  subsections: ReadonlyArray<{
    label: string;
    fields: ReadonlyArray<HostConfigFieldDef>;
  }>;
  subjects: ReadonlyArray<HostComparisonSubject>;
  divergingIds: ReadonlySet<string>;
  divergingOnly: boolean;
}

function SectionRows({
  sectionLabel,
  divergeCount,
  subsections,
  subjects,
  divergingIds,
  divergingOnly,
}: SectionRowsProps) {
  const colSpan = subjects.length + 1;
  return (
    <>
      <tr>
        <th
          colSpan={colSpan}
          scope="colgroup"
          className="sticky top-[64px] z-20 bg-secondary border-y border-border px-5 py-2 text-left"
        >
          <div className="flex items-baseline gap-3">
            <span className="text-[15px] font-medium tracking-tight">
              {sectionLabel}
            </span>
            <span className="ml-auto text-[10.5px] text-muted-foreground tabular-nums">
              {divergeCount} diverging
            </span>
          </div>
        </th>
      </tr>

      {subsections.map((sub) => {
        const fields = sub.fields.filter(
          (f) => !divergingOnly || divergingIds.has(f.id),
        );
        if (fields.length === 0) return null;
        return (
          <SubsectionRows
            key={`${sectionLabel}-${sub.label}`}
            label={sub.label}
            fields={fields}
            subjects={subjects}
            divergingIds={divergingIds}
            colSpan={colSpan}
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
}: {
  label: string;
  fields: ReadonlyArray<HostConfigFieldDef>;
  subjects: ReadonlyArray<HostComparisonSubject>;
  divergingIds: ReadonlySet<string>;
  colSpan: number;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={colSpan}
          className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground"
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
        />
      ))}
    </>
  );
}

function FieldRow({
  field,
  subjects,
  diverges,
}: {
  field: HostConfigFieldDef;
  subjects: ReadonlyArray<HostComparisonSubject>;
  diverges: boolean;
}) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td
        className={cn(
          "sticky left-0 z-10 bg-card border-r border-border px-5 py-2.5",
          "relative",
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
        <div className="text-[13px] font-medium text-foreground leading-tight">
          {field.label}
        </div>
        {field.description && (
          <div className="text-[11px] text-muted-foreground mt-1 leading-snug">
            {field.description}
          </div>
        )}
      </td>
      {subjects.map((s) => (
        <td
          key={s.hostId}
          className="border-l border-border px-4 py-2.5 align-top"
        >
          <FieldCell field={field} subject={s} />
        </td>
      ))}
    </tr>
  );
}

function FieldCell({
  field,
  subject,
}: {
  field: HostConfigFieldDef;
  subject: HostComparisonSubject;
}) {
  const value = field.read(subject.config);
  const kind = field.kind;

  // Tri-state fields treat `undefined` as a meaningful value ("auto" — host
  // decides), so we must NOT short-circuit on undefined for them. Every
  // other kind renders absence as `—`.
  if (value === undefined && kind.kind !== "tri-state") {
    return <span className="text-[12px] text-muted-foreground/60">—</span>;
  }

  switch (kind.kind) {
    case "boolean":
      return <BooleanCellValue value={value === true} />;

    case "tri-state":
      return (
        <TriStateCellValue
          value={
            value === true ? true : value === false ? false : undefined
          }
        />
      );

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

    case "enum":
      return <span className="text-[13px] text-foreground">{String(value)}</span>;

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
            {firstLine || <span className="italic text-muted-foreground">empty</span>}
          </div>
          {s.length > 0 && (
            <ExpandablePreview label={`view ${s.length.toLocaleString()} chars`}>
              <pre className="whitespace-pre-wrap text-[11.5px] leading-snug font-mono max-w-[480px] max-h-[320px] overflow-auto">
                {s}
              </pre>
            </ExpandablePreview>
          )}
        </div>
      );
    }

    case "string-array": {
      if (!Array.isArray(value)) return <span className="text-[12px] text-muted-foreground/60">—</span>;
      if (value.length === 0) {
        return <span className="text-[12px] text-muted-foreground/60">[] empty</span>;
      }
      return (
        <span className="text-[13px] text-foreground leading-snug">
          {value.join(", ")}
        </span>
      );
    }

    case "object": {
      if (typeof value !== "object" || value === null) {
        return <span className="text-[12px] text-muted-foreground/60">—</span>;
      }
      const keys = Object.keys(value as Record<string, unknown>);
      const noun = kind.itemNoun ?? "key";
      if (keys.length === 0) {
        return (
          <span className="font-mono text-[11px] text-muted-foreground">
            {"{} empty"}
          </span>
        );
      }
      return (
        <ExpandablePreview
          label={`${keys.length} ${noun}${keys.length === 1 ? "" : "s"} ›`}
        >
          <pre className="whitespace-pre-wrap text-[11.5px] leading-snug font-mono max-w-[480px] max-h-[320px] overflow-auto">
            {JSON.stringify(value, null, 2)}
          </pre>
        </ExpandablePreview>
      );
    }
  }
}

function BooleanCellValue({ value }: { value: boolean }) {
  return (
    <span
      className={cn(
        "text-[13px]",
        value ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {value ? "Yes" : "No"}
    </span>
  );
}

function TriStateCellValue({
  value,
}: {
  value: boolean | undefined;
}) {
  const label =
    value === true ? "On" : value === false ? "Off" : "Auto";
  return (
    <span
      className={cn(
        "text-[13px]",
        value === true && "text-foreground",
        value === false && "text-muted-foreground",
        value === undefined && "text-muted-foreground/80",
      )}
    >
      {label}
    </span>
  );
}

function HostColumnHeader({
  subject,
  onRemove,
}: {
  subject: HostComparisonSubject;
  onRemove?: (hostId: string) => void;
}) {
  const logoSrc = getChatboxHostLogo(
    subject.hostStyle,
    subject.config.chatUiOverride,
  );
  const reduceMotion = useReducedMotion();

  return (
    <th className="sticky top-0 z-20 bg-card border-b border-l border-border px-4 py-4 text-left align-top">
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
        <div className="min-w-0 font-medium text-[14px] truncate leading-tight" title={subject.hostName}>
          {subject.hostName}
        </div>
      </motion.div>
    </th>
  );
}

function ExpandablePreview({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
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
      <PopoverContent className="max-w-[520px] max-h-[400px] overflow-auto p-3">
        {children}
      </PopoverContent>
    </Popover>
  );
}
