/**
 * Phase 2 — persona roster building blocks (Inspector).
 *
 * `CharacterAvatar`, the selectable `PersonaCard`, the track-record panel, and
 * the Convex hooks the Personas tab + the swarm launch dialog share. The track
 * record renders Phase 1 readiness aggregates (run/session counts, issues,
 * failing tools); goal-rate is omitted until Phase 3.
 */

import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { Loader2, Wrench } from "lucide-react";
import type {
  SessionReadinessRollup,
  ReadinessStatus,
} from "@/components/chatboxes/session-readiness";

// ── types (mirror chatboxPersonas serialization) ─────────────────────────────

/** Inline persona payload (the slate shape the runner / `/start` consumes). */
export interface PersonaSlate {
  id: string;
  name: string;
  role: string;
  notes: string;
}

export type PersonaSource = "manual" | "generated" | "cluster";

export interface RosterPersona {
  _id: string;
  personaId: string;
  name: string;
  role: string;
  notes: string;
  source: PersonaSource;
  seedThemeClusterId?: string;
  seedKeywords?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PersonaTrackRecord {
  persona: RosterPersona;
  runCount: number;
  sessionCount: number;
  readiness: SessionReadinessRollup;
  sessionExamples: Array<{
    _id: string;
    chatSessionId: string;
    startedAt: number;
    lastActivityAt: number;
    readiness?: {
      status: ReadinessStatus;
      verdict?: "ready" | "needs_attention" | "not_ready";
      issueCount: number;
    };
  }>;
}

// ── convex hooks ───────────────────────────────────────────────────────────

export function usePersonaRoster(chatboxId: string | null) {
  return useQuery(
    "chatboxPersonas:listChatboxPersonas" as any,
    chatboxId ? ({ chatboxId } as any) : "skip"
  ) as RosterPersona[] | undefined;
}

export function usePersonaTrackRecord(personaRefId: string | null) {
  return useQuery(
    "chatboxPersonas:getPersonaTrackRecord" as any,
    personaRefId ? ({ personaRefId } as any) : "skip"
  ) as PersonaTrackRecord | null | undefined;
}

export function usePersonaMutations() {
  const create = useMutation("chatboxPersonas:createChatboxPersona" as any);
  const update = useMutation("chatboxPersonas:updateChatboxPersona" as any);
  const remove = useMutation("chatboxPersonas:deleteChatboxPersona" as any);
  const seedFromClusters = useMutation(
    "chatboxPersonas:seedPersonasFromClusters" as any
  );
  return { create, update, remove, seedFromClusters };
}

// ── CharacterAvatar ───────────────────────────────────────────────────────────

const AVATAR_PALETTE = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-lime-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-sky-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-fuchsia-500",
];

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function CharacterAvatar({
  name,
  seed,
  size = "md",
  className = "",
}: {
  name: string;
  /** Stable key for color selection (persona id); falls back to the name. */
  seed?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const color =
    AVATAR_PALETTE[hashString(seed || name) % AVATAR_PALETTE.length];
  const dims =
    size === "lg"
      ? "size-12 text-base"
      : size === "sm"
      ? "size-7 text-[10px]"
      : "size-9 text-xs";
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${color} ${dims} ${className}`}
      aria-hidden
    >
      {initials(name)}
    </div>
  );
}

// ── PersonaCard (character-select grid item) ─────────────────────────────────

const SOURCE_LABEL: Record<PersonaSource, string> = {
  manual: "Custom",
  generated: "AI",
  cluster: "From traffic",
};

export function PersonaCard({
  persona,
  selected,
  onToggle,
  onOpenDetail,
}: {
  persona: RosterPersona;
  selected: boolean;
  onToggle: () => void;
  onOpenDetail?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      onDoubleClick={onOpenDetail}
      aria-pressed={selected}
      className={`flex w-full flex-col gap-2 rounded-xl border p-3 text-left transition-colors ${
        selected
          ? "border-primary/60 bg-primary/5 ring-1 ring-primary/40"
          : "border-border/60 hover:bg-muted/40"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <CharacterAvatar name={persona.name} seed={persona.personaId} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{persona.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {persona.role}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {SOURCE_LABEL[persona.source]}
        </span>
      </div>
      {persona.notes ? (
        <p className="line-clamp-2 text-xs text-muted-foreground/80">
          {persona.notes}
        </p>
      ) : null}
    </button>
  );
}

// ── track record ───────────────────────────────────────────────────────────

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

/**
 * Persona track record: run/session counts plus the Phase 1 readiness rollup
 * for the persona's synthetic sessions. Goal-completion rate is intentionally
 * omitted (Phase 3).
 */
export function PersonaTrackRecordPanel({
  personaRefId,
}: {
  personaRefId: string | null;
}) {
  const record = usePersonaTrackRecord(personaRefId);

  if (personaRefId === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select a character to see its track record
      </div>
    );
  }
  if (record === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  if (record === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Character not found
      </div>
    );
  }

  const { persona, readiness } = record;
  const coverage =
    typeof readiness.avgCoverageRatio === "number"
      ? `${Math.round(readiness.avgCoverageRatio * 100)}%`
      : "—";

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
      <div className="flex items-center gap-3">
        <CharacterAvatar
          name={persona.name}
          seed={persona.personaId}
          size="lg"
        />
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{persona.name}</h3>
          <p className="truncate text-sm text-muted-foreground">
            {persona.role}
          </p>
        </div>
      </div>
      {persona.notes ? (
        <p className="text-sm text-muted-foreground">{persona.notes}</p>
      ) : null}

      <div className="grid grid-cols-4 gap-3 rounded-xl border p-4">
        <Stat value={record.runCount} label="runs" />
        <Stat value={record.sessionCount} label="sessions" />
        <Stat value={readiness.totalIssues} label="issues" />
        <Stat value={coverage} label="avg coverage" />
      </div>

      {record.sessionCount === 0 ? (
        <p className="text-sm text-muted-foreground">
          No synthetic sessions yet. Run a swarm to build this character's track
          record.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-emerald-600 dark:text-emerald-400">
              {readiness.byVerdict.ready} ready
            </span>
            <span className="text-amber-600 dark:text-amber-400">
              {readiness.byVerdict.needs_attention} needs attention
            </span>
            <span className="text-red-600 dark:text-red-400">
              {readiness.byVerdict.not_ready} not ready
            </span>
          </div>
          {readiness.topFailingTools.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Most common failing tools
              </p>
              <div className="flex flex-wrap gap-1.5">
                {readiness.topFailingTools.map((t) => (
                  <span
                    key={t.toolName}
                    className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400"
                  >
                    <Wrench className="size-3" />
                    {t.toolName}
                    <span className="text-red-700/60 dark:text-red-400/60">
                      {t.errorCount}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Memoized sort: most-recently-updated personas first. */
export function useSortedRoster(
  roster: RosterPersona[] | undefined
): RosterPersona[] | undefined {
  return useMemo(
    () =>
      roster ? [...roster].sort((a, b) => b.updatedAt - a.updatedAt) : roster,
    [roster]
  );
}
