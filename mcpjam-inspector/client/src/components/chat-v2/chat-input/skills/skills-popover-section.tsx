import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/chat-utils";
import { SquareSlash, Loader2 } from "lucide-react";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  listSkills,
  getSkill,
  type SkillsSource,
} from "@/lib/apis/mcp-skills-api";
import type { SkillListItem, SkillResult } from "./skill-types";
import {
  getServerSkill,
  listServerSkills,
  type ServerSkillSummary,
} from "@/lib/apis/server-skills-api";
import { buildServerSkillToolOutput } from "@/shared/server-skill-banner";
import { assignServerSlugs, assignSkillRefs } from "@/shared/server-skill-refs";
import type { ServerSkillsSectionServer } from "@/components/skills/ServerSkillsSection";
import { track } from "@/lib/analytics";

interface SkillsPopoverSectionProps {
  onSkillSelected: (skillResult: SkillResult) => void;
  highlightedIndex: number;
  setHighlightedIndex: (index: number) => void;
  startIndex: number; // Index offset for highlighting (after prompts)
  isHovering: boolean;
  actionTrigger: string | null;
  onOpenUploadDialog?: () => void;
  /**
   * The project LIBRARY half, when there is one to read. Absent (no synced
   * project, or the `skills-enabled` flag off) ⇒ the picker shows the local
   * half and server skills only.
   */
  skillsSource?: SkillsSource;
  /**
   * Connected MCP servers whose skills (SEP-2640) may be injected. Read live
   * per connection, so a disconnected server contributes nothing rather than a
   * stale catalog.
   */
  mcpServers?: ServerSkillsSectionServer[];
  /** Convex project id — required for the hosted server-skills route. */
  projectId?: string;
  /**
   * Reports the TOTAL selectable-row count (local + library + server skills)
   * upward.
   *
   * The parent drives arrow navigation and its open/closed state from this, so
   * a count that omitted server skills would leave those rows keyboard-
   * unreachable and keep the popover shut for a user whose only skills come
   * from a connected server.
   */
  onCountChange?: (count: number) => void;
}

/** One server skill in the picker, plus the provider it came from. */
interface ServerSkillPickerItem extends ServerSkillSummary {
  serverLabel: string;
  /** `<serverSlug>/<name>` — the same address the chat wrapper uses. */
  ref: string;
}

/**
 * One project-skill row, carrying the source it was listed FROM.
 *
 * The picker used to show one half or the other — local files XOR the project
 * library, decided by build mode — so a single ambient `skillsSource` said
 * where every row came from. It now shows both, and the two are genuinely
 * different artifacts that may share a name, so the source travels with the
 * row: it is what `getSkill` reads through, and what gets stamped onto the
 * selection so later file reads resolve against the same store.
 */
interface SkillRow {
  item: SkillListItem;
  /** `{kind:'local'}` or the library source — never absent. */
  source: SkillsSource;
  label: "Local" | "Library";
}

/**
 * Identity for one row's React key and its loading spinner.
 *
 * The name alone is not it: the two halves may each hold a `refunds`, and a
 * name-keyed spinner would spin on both rows while one of them loads.
 */
function rowKey(row: SkillRow): string {
  return `${row.source.kind}:${row.item.name}`;
}

export function SkillsPopoverSection({
  onSkillSelected,
  highlightedIndex,
  setHighlightedIndex,
  startIndex,
  isHovering,
  actionTrigger,
  onOpenUploadDialog,
  skillsSource,
  mcpServers,
  projectId,
  onCountChange,
}: SkillsPopoverSectionProps) {
  // One slice per half, `null` while that half is still outstanding. Kept
  // apart rather than merged into one array so each can land on its own — see
  // the fetch effect — and so row ORDER stays local-then-library whichever
  // arrives first.
  const [localRows, setLocalRows] = useState<SkillRow[] | null>(null);
  const [libraryRows, setLibraryRows] = useState<SkillRow[] | null>(null);
  const [serverSkills, setServerSkills] = useState<ServerSkillPickerItem[]>([]);
  const [loadingSkillName, setLoadingSkillName] = useState<string | null>(null);
  // Why a rendered field and not just a console line: the person who clicked
  // the row is the one who needs to know it was refused, and they are not
  // looking at the devtools console.
  const [serverSkillError, setServerSkillError] = useState<string | null>(null);

  /**
   * Both halves of the project catalog, each rendering the moment it lands.
   *
   * The local half is always requested: `listSkills(undefined)` self-empties
   * in hosted mode (`runByMode`), where there is no filesystem to read, so the
   * caller needs no build-mode branch of its own. The library half is
   * requested only when there is a library to read.
   *
   * Each half owns its own state slice and settles alone. Awaiting the PAIR —
   * even with `allSettled` — buys independence from one half FAILING but none
   * from one half being SLOW: a Convex request that hangs rather than rejects
   * would hold back local files that were ready, behind a spinner, for as
   * long as it took. A rejection logs and yields an empty half so the other
   * still renders.
   *
   * NOT deduped by name. A local `refunds` and a library `refunds` are
   * different artifacts with different contents, and the person typing `/` is
   * choosing between them — collapsing them into one row would pick for them,
   * silently and by fetch order. They render twice, badged.
   */
  useEffect(() => {
    let active = true;
    setLocalRows(null);
    setLibraryRows(null);
    listSkills(undefined).then(
      (items) => {
        if (!active) return;
        setLocalRows(
          items.map((item) => ({
            item,
            source: { kind: "local" } as SkillsSource,
            label: "Local" as const,
          }))
        );
      },
      (err) => {
        if (!active) return;
        console.error(
          "[SkillsPopoverSection] Failed to fetch local skills",
          err
        );
        setLocalRows([]);
      }
    );
    if (skillsSource) {
      listSkills(skillsSource).then(
        (items) => {
          if (!active) return;
          setLibraryRows(
            items.map((item) => ({
              item,
              source: skillsSource,
              label: "Library" as const,
            }))
          );
        },
        (err) => {
          if (!active) return;
          console.error(
            "[SkillsPopoverSection] Failed to fetch library skills",
            err
          );
          setLibraryRows([]);
        }
      );
    }
    return () => {
      active = false;
    };
  }, [skillsSource]);

  // Local first, so the badge order on screen matches the index order the
  // Enter handler and the parent's arrow keys walk.
  const skills = useMemo(
    () => [...(localRows ?? []), ...(libraryRows ?? [])],
    [localRows, libraryRows]
  );
  /** A half that was asked for and hasn't answered. */
  const stillFetching =
    localRows === null || (Boolean(skillsSource) && libraryRows === null);
  // The spinner stands only while NOTHING has arrived. Once either half is in,
  // it renders — a hung half must not hide a settled one.
  const isLoading =
    localRows === null && (skillsSource ? libraryRows === null : true);

  // Server-served skills (SEP-2640). Fetched per connected server, and only
  // for connections where the extension is mutually declared — the API answers
  // with `support.active: false` and an empty list otherwise, so a
  // non-declaring server contributes nothing.
  //
  // Keyed on a VALUE signature of the connected server ids, not on the
  // `mcpServers` array identity: the parent rebuilds that array on render, and
  // depending on its reference would make every completed fetch trigger the
  // next one.
  //
  // Covers every server's id, label and connected flag — not just the
  // connected ids. Slugs are assigned over the full list, so renaming a
  // DISCONNECTED server can still change a connected server's ref, and the
  // rows would otherwise keep showing the old one.
  const connectedServerSignature = JSON.stringify(
    (mcpServers ?? []).map((server) => [
      server.serverId,
      server.label,
      server.connected,
    ])
  );

  useEffect(() => {
    let active = true;
    // The rows are about to be replaced, so a refusal naming one of the old
    // ones would sit above a list that no longer contains it.
    setServerSkillError(null);
    const connected = (mcpServers ?? []).filter((server) => server.connected);
    if (connected.length === 0) {
      setServerSkills([]);
      return;
    }
    (async () => {
      // Slugs come from the SHARED assigner, over the FULL server list rather
      // than the connected subset — the chat wrapper assigns over its full
      // candidate list too, and both must describe the same namespace or the
      // ref shown here is not the ref `loadSkill` resolves. Only the connected
      // ones are then listed.
      const assigned = assignServerSlugs(
        (mcpServers ?? []).map((server) => ({
          serverId: server.serverId,
          serverLabel: server.label,
          connected: server.connected,
        }))
      ).filter(({ server }) => server.connected);
      // Concurrent: one slow server must not delay every other server's rows.
      const perServer = await Promise.all(
        assigned.map(async ({ server, serverSlug }) => {
          try {
            const listing = await listServerSkills({
              serverId: server.serverId,
              ...(projectId ? { projectId } : {}),
            });
            // Duplicate names within one server are disambiguated by the same
            // shared rule the wrapper applies, so a ref clicked here addresses
            // the skill the catalog means by it.
            const refs = await assignSkillRefs(serverSlug, listing.skills);
            return refs.map(({ skill, ref }) => ({
              ...skill,
              serverLabel: server.serverLabel,
              ref,
            }));
          } catch {
            // One unreachable server must not remove another's skills from the
            // picker, and a failed listing is not worth a UI error here.
            return [] as ServerSkillPickerItem[];
          }
        })
      );
      if (active) setServerSkills(perServer.flat());
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedServerSignature, projectId]);

  /**
   * Injects a server skill as a synthetic `loadSkill` result.
   *
   * The content is loaded through the SAME verified path the chat tool uses,
   * and wrapped in the SAME shared banner — a popover click must produce a
   * message the tool could genuinely have returned. A skill that fails a
   * mandatory check is not injected at all: silently injecting unverified
   * content would defeat every check upstream of it.
   */
  const handleServerSkillClick = useCallback(
    async (item: ServerSkillPickerItem) => {
      setServerSkillError(null);
      // Refused HERE rather than by disabling the button: a disabled button
      // swallows the pointer events Radix needs, so the tooltip explaining WHY
      // would never appear.
      if (item.unloadable) {
        setServerSkillError(item.unloadable.message);
        console.warn(
          "[SkillsPopoverSection] Refusing unverifiable server skill",
          item.unloadable.message
        );
        return;
      }
      try {
        setLoadingSkillName(item.ref);
        const result = await getServerSkill({
          serverId: item.serverId,
          uri: item.skillUri,
          ...(projectId ? { projectId } : {}),
        });
        if (!result.ok) {
          setServerSkillError(result.refusal.message);
          console.error(
            "[SkillsPopoverSection] Server skill refused",
            result.refusal
          );
          return;
        }
        track("skill_injected", {
          location: "chat_input_skills_popover",
          skill_name: item.ref,
          skill_origin: "mcp-server",
        });
        onSkillSelected({
          name: item.ref,
          description: result.skill.description,
          content: result.skill.content,
          path: result.skill.skillUri,
          toolOutput: buildServerSkillToolOutput({
            ref: item.ref,
            serverLabel: item.serverLabel,
            skillUri: result.skill.skillUri,
            content: result.skill.content,
          }),
        });
      } catch (error) {
        // An INTEGRITY failure comes back as `{ ok: false }`; a TRANSPORT
        // failure THROWS. Without this catch the second is an unhandled
        // rejection and the row just stops spinning with no explanation.
        setServerSkillError(
          error instanceof Error ? error.message : "Unknown error"
        );
      } finally {
        setLoadingSkillName(null);
      }
    },
    [onSkillSelected, projectId]
  );

  const handleSkillClick = useCallback(
    async (row: SkillRow) => {
      try {
        setLoadingSkillName(rowKey(row));
        // The ROW's source, not the ambient one: with both halves on screen a
        // local `refunds` and a library `refunds` are two different rows, and
        // reading either through the wrong store returns the other's content.
        const fullSkill = await getSkill(row.item.name, row.source);
        track("skill_injected", {
          location: "chat_input_skills_popover",
          skill_name: row.item.name,
          skill_origin: row.label === "Library" ? "library" : "local",
        });
        // Stamped ALWAYS, including for local rows. `SkillResultCard` falls
        // back to its ambient source prop for an unstamped result, and that
        // prop is now the library in both build modes — so an unstamped local
        // selection would expand into file reads against Convex. The fallback
        // remains only for results persisted before this stamp existed.
        onSkillSelected({ ...fullSkill, source: row.source });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[SkillsPopoverSection] Failed to get skill", message);
      } finally {
        setLoadingSkillName(null);
      }
    },
    [onSkillSelected]
  );

  /**
   * Every selectable row, in index order, identified rather than numbered.
   *
   * The parent navigates by a single number across BOTH lists, so following a
   * shifted row means describing the whole range — project rows then server
   * rows, exactly as they render. Prefixed so a project row can never collide
   * with a server row that happens to share its text.
   */
  const rowKeys = useMemo(
    () => [
      ...skills.map((row) => `project:${rowKey(row)}`),
      ...serverSkills.map((item) => `server:${item.serverId}:${item.skillUri}`),
    ],
    [skills, serverSkills]
  );

  /**
   * Keep the keyboard highlight on the ROW it was on when a late half lands.
   *
   * Rendering each half as it settles means the list can grow at the FRONT:
   * if the library answers first and the local half arrives after, local rows
   * are prepended and everything below them shifts down — library rows and,
   * because they occupy the indices after the project list, server rows too.
   * The parent holds only a numeric `highlightedIndex`, so without this the
   * highlight — and the row Enter would select — slides silently onto a
   * different skill while someone is browsing.
   *
   * Looks up where the previously highlighted row went and follows it. Keyed
   * on the row list alone: reacting to `highlightedIndex` too would fight the
   * parent's own arrow-key updates.
   */
  const prevRowKeysRef = useRef<string[]>(rowKeys);
  useEffect(() => {
    const prev = prevRowKeysRef.current;
    prevRowKeysRef.current = rowKeys;
    if (prev === rowKeys || prev.length === 0) return;
    const wasAt = highlightedIndex - startIndex;
    if (wasAt < 0 || wasAt >= prev.length) return;
    const nowAt = rowKeys.indexOf(prev[wasAt]!);
    if (nowAt !== -1 && nowAt !== wasAt) setHighlightedIndex(startIndex + nowAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowKeys]);

  // The parent's navigation range must cover BOTH lists — see `onCountChange`.
  useEffect(() => {
    onCountChange?.(skills.length + serverSkills.length);
  }, [skills.length, serverSkills.length, onCountChange]);

  // Handle Enter key on the highlighted row. Server skills occupy the indices
  // AFTER the project skills, matching their render order below.
  useEffect(() => {
    if (actionTrigger !== "Enter") return;
    const localIndex = highlightedIndex - startIndex;
    if (localIndex < 0) return;
    if (localIndex < skills.length) {
      handleSkillClick(skills[localIndex]!);
      return;
    }
    const serverIndex = localIndex - skills.length;
    const item = serverSkills[serverIndex];
    if (item) handleServerSkillClick(item);
  }, [
    actionTrigger,
    highlightedIndex,
    startIndex,
    skills,
    serverSkills,
    handleSkillClick,
    handleServerSkillClick,
  ]);

  // Don't render anything if still loading or no skills
  if (isLoading) {
    return (
      <div className="px-2 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          Loading skills...
        </div>
      </div>
    );
  }

  if (skills.length === 0 && serverSkills.length === 0 && !onOpenUploadDialog) {
    return null;
  }

  return (
    <div>
      {/* Section header */}
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground border-t border-border mt-1 pt-2">
        <span>SKILLS</span>
      </div>

      {/* Skills list */}
      <div className="flex flex-col">
        {skills.map((row, index) => {
          const globalIndex = startIndex + index;
          const isHighlighted = highlightedIndex === globalIndex;
          const key = rowKey(row);
          const isLoadingThis = loadingSkillName === key;

          return (
            <Tooltip key={key} delayDuration={1000}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "flex items-center gap-2 rounded-sm px-2 max-w-[300px] py-1.5 text-xs select-none hover:bg-accent hover:text-accent-foreground",
                    isHighlighted ? "bg-accent text-accent-foreground" : ""
                  )}
                  onClick={() => handleSkillClick(row)}
                  onMouseEnter={() => {
                    if (isHovering) {
                      setHighlightedIndex(globalIndex);
                    }
                  }}
                >
                  <SquareSlash size={16} className="shrink-0 text-primary" />
                  <span className="flex-1 text-left truncate">
                    {row.item.name}
                  </span>
                  {/* Which store this row is, carried on the row rather than
                      in a group heading: the same name can legitimately appear
                      in both halves, and the badge is what tells them apart at
                      the moment of choosing. */}
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                    {row.label}
                  </span>
                  {isLoadingThis && (
                    <Loader2
                      size={14}
                      className="text-muted-foreground shrink-0 ml-2 animate-spin"
                      aria-label="Loading"
                    />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>{row.item.description}</TooltipContent>
            </Tooltip>
          );
        })}

        {/* Server-served skills (SEP-2640), grouped under their own heading.
            Kept visually distinct from project skills because their contents
            come from a third party — the same reason the injected message
            carries an origin banner. */}
        {serverSkills.length > 0 && (
          <>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
              From MCP servers
            </div>
            {serverSkills.map((item, index) => {
              const isLoadingThis = loadingSkillName === item.ref;
              // Indices continue AFTER the project skills, matching the Enter
              // handler above.
              const globalIndex = startIndex + skills.length + index;
              const isHighlighted = highlightedIndex === globalIndex;
              return (
                // Server-scoped key: two servers may legally publish the same
                // skill URI, and a bare URI key would reuse one row's tooltip
                // and button for the other.
                <Tooltip
                  key={`${item.serverId}:${item.skillUri}`}
                  delayDuration={1000}
                >
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      // NOT `disabled`: a disabled button swallows the pointer
                      // events Radix needs, so the tooltip explaining the
                      // refusal would never appear. `handleServerSkillClick`
                      // refuses instead.
                      aria-disabled={Boolean(item.unloadable)}
                      className={cn(
                        "flex items-center gap-2 rounded-sm px-2 max-w-[300px] py-1.5 text-xs select-none hover:bg-accent hover:text-accent-foreground",
                        isHighlighted ? "bg-accent text-accent-foreground" : "",
                        item.unloadable ? "opacity-60 cursor-not-allowed" : ""
                      )}
                      onClick={() => handleServerSkillClick(item)}
                      onMouseEnter={() => {
                        if (isHovering) setHighlightedIndex(globalIndex);
                      }}
                    >
                      <SquareSlash
                        size={16}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span className="flex-1 text-left truncate">
                        {item.ref}
                      </span>
                      {isLoadingThis && (
                        <Loader2
                          size={14}
                          className="text-muted-foreground shrink-0 ml-2 animate-spin"
                          aria-label="Loading"
                        />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {item.unloadable
                      ? item.unloadable.message
                      : `${item.description} — served by "${item.serverLabel}"`}
                  </TooltipContent>
                </Tooltip>
              );
            })}
            {serverSkillError && (
              <div
                role="alert"
                className="mx-2 mt-1 rounded-sm bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
              >
                {serverSkillError}
              </div>
            )}
          </>
        )}

        {/* Empty state with upload button */}
        {skills.length === 0 &&
          serverSkills.length === 0 &&
          !stillFetching &&
          onOpenUploadDialog && (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              No skills found. Create your first skill!
            </div>
          )}
      </div>
    </div>
  );
}

