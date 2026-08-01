import { useMemo } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { getChatboxHostLogo } from "@/lib/chatbox-client-style";
import type { HostThemeMode } from "@/lib/client-styles";
import {
  HOST_CONFIG_FIELDS,
  type HostComparisonSubject,
} from "@/lib/host-config-field-schema";
import { SupportChip } from "./support-chip";
import {
  computeVisibleFieldIds,
  getSupportLevel,
  isSupportField,
  type SupportFilterMode,
  type SupportLevel,
} from "./support-level";

interface HostCapabilityListViewProps {
  subjects: ReadonlyArray<HostComparisonSubject>;
  divergingOnly?: boolean;
  supportFilter?: SupportFilterMode;
  searchQuery?: string;
  themeMode?: HostThemeMode;
}

/**
 * caniuse "Supported" / "No support" walls, one block per host column. Titles
 * are kind-agnostic: `neutral` spans boolean No, tri-state Off, and
 * not-advertised capabilities, so it reads "Off / absent" rather than implying
 * a capability was never advertised.
 */
const GROUPS: ReadonlyArray<{ level: SupportLevel; title: string }> = [
  { level: "supported", title: "Supported" },
  { level: "partial", title: "Partial" },
  { level: "neutral", title: "Off / absent" },
];

export function HostCapabilityListView({
  subjects,
  divergingOnly = false,
  supportFilter = "all",
  searchQuery = "",
  themeMode = "light",
}: HostCapabilityListViewProps) {
  const configs = useMemo(() => subjects.map((s) => s.config), [subjects]);
  const visibleFieldIds = useMemo(
    () =>
      computeVisibleFieldIds({
        configs,
        divergingOnly,
        supportFilter,
        searchQuery,
      }),
    [configs, divergingOnly, supportFilter, searchQuery],
  );

  // Support-shaped, currently-visible fields in registry order. Support-shape
  // is kind-based (`isSupportField`), so this needs no host config — avoids
  // reading `configs[0]` while subjects are still hydrating (subjects can be
  // empty here even when hosts are selected).
  const fields = useMemo(
    () => HOST_CONFIG_FIELDS.filter((f) => visibleFieldIds.has(f.id) && isSupportField(f)),
    [visibleFieldIds],
  );

  if (subjects.length === 0) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center text-sm text-muted-foreground">
        No hosts to compare. Create at least one host in this project.
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <div className="flex h-full min-h-[160px] items-center justify-center rounded-xl border border-border bg-card text-sm text-muted-foreground">
        No capabilities match the current search and filters.
      </div>
    );
  }

  return (
    <div
      className="grid gap-4"
      style={{
        // auto-fit + min(100%, …) → one full-width column on phones, packing to
        // multiple columns as the viewport widens (collapses empty tracks).
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
      }}
    >
      {subjects.map((subject) => (
        <HostListColumn
          key={subject.hostId}
          subject={subject}
          fields={fields}
          themeMode={themeMode}
        />
      ))}
    </div>
  );
}

function HostListColumn({
  subject,
  fields,
  themeMode,
}: {
  subject: HostComparisonSubject;
  fields: ReadonlyArray<(typeof HOST_CONFIG_FIELDS)[number]>;
  themeMode: HostThemeMode;
}) {
  const logoSrc = getChatboxHostLogo(
    subject.hostStyle,
    subject.config.chatUiOverride,
    themeMode,
  );

  // Bucket every visible support-shaped field by its level for this host.
  const byLevel = useMemo(() => {
    const map: Record<SupportLevel, string[]> = {
      supported: [],
      partial: [],
      neutral: [],
      unsupported: [],
    };
    for (const f of fields) {
      const level = getSupportLevel(f, subject.config);
      if (level) map[level].push(f.label);
    }
    return map;
  }, [fields, subject.config]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <img src={logoSrc} alt="" className="size-4 shrink-0 object-contain" />
        <span className="truncate text-[14px] font-medium" title={subject.hostName}>
          {subject.hostName}
        </span>
      </div>

      {GROUPS.map(({ level, title }) => {
        const labels = byLevel[level];
        if (labels.length === 0) return null;
        return (
          <div key={level} className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] font-medium text-foreground">
                {title}
              </span>
              <span className="text-[10.5px] tabular-nums text-muted-foreground">
                {labels.length}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {labels.map((label) => (
                <SupportChip
                  key={label}
                  level={level}
                  label={label}
                  className={cn(level === "neutral" && "opacity-90")}
                />
              ))}
            </div>
          </div>
        );
      })}
    </motion.div>
  );
}
