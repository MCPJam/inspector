/**
 * The two-tab server picker panel. Servers and groups are SIBLING tabs,
 * Servers first, and a group shows its members as static chips — nothing here
 * expands. Presentational and fully controlled: it takes a resolved
 * `{ label, indicatorClassName }`, so it imports nothing from the app.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Badge } from "./badge";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Input } from "./input";
import { Label } from "./label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
import { cn } from "../cn";

/** Which tab the panel is showing. Structurally identical to the app's own. */
export type PickerTab = "servers" | "groups";

export type ServerPickerServerRow = {
  id: string;
  name: string;
  /** A role-token class, so the dot follows the theme; a hex cannot. */
  status: { label: string; indicatorClassName: string };
  /** Absent means "nothing to do here" — the panel owns no status rules. */
  onConnect?: () => void;
};

export type ServerPickerGroupRow = {
  id: string;
  name: string;
  serverNames: string[];
};

export type ServerPickerPanelProps = {
  tab: PickerTab;
  onTabChange: (tab: PickerTab) => void;
  servers: readonly ServerPickerServerRow[];
  groups: readonly ServerPickerGroupRow[];
  selectedServerId?: string | null;
  selectedGroupId?: string | null;
  onSelectServer: (serverId: string) => void;
  onSelectGroup: (groupId: string) => void;
  /**
   * Submit a new group. Awaited: the form stays put until it resolves, so a
   * rejection does not cost the user the servers they picked.
   */
  onCreateGroup: (name: string, serverIds: string[]) => void | Promise<void>;
  /** Injected: the rule depends on project names the panel cannot see. */
  deriveName?: (pickedServerNames: string[]) => string;
  /**
   * Has the catalog ANSWERED. `false` is unknown, not empty. Defaults true so
   * a caller that already has rows says nothing.
   */
  catalogKnown?: boolean;
  /**
   * A write the caller started is still in flight. It refuses anything further
   * until that lands, so the controls stop offering what would be refused —
   * a refusal the user cannot see reads as a dead control.
   */
  busy?: boolean;
  /**
   * Remove a group. Only callers that can perform the write pass it, and only
   * they get the control — the panel cannot tell a removable row from one the
   * backend will refuse.
   */
  onDeleteGroup?: (groupId: string) => void;
  /**
   * Whether the CURRENTLY SELECTED group can be deleted. Callers that cannot
   * be told about a clear refuse that delete, and a control offered only to be
   * denied is a dead control. Defaults true so a caller that never refuses
   * says nothing.
   */
  canDeleteSelected?: boolean;
  /**
   * Room for the chips, in pixels — the lane a `w-72` popover leaves them.
   * Spent against `chipWidth`, an estimate: real width is not observable in
   * jsdom, so the budget is what a test can pin.
   */
  chipRoomPx?: number;
};

const ROW = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left";

/** The wrapper a row shares with its trailing actions, which reveal on hover. */
const ROW_WRAP = "group flex items-center gap-1 rounded pr-1 hover:bg-accent";

/** `muted`, not the Badge's `secondary`: the lighter of two near-whites. */
const CHIP =
  "rounded-full border-transparent bg-muted px-2 py-0 text-[11px] font-normal text-muted-foreground";

/**
 * Roughly what a chip occupies, in pixels. Measured in the app at 11px: the
 * flat 22 is padding plus gap, then 5.2px a latin character and 11.5px a wide
 * one. Counting characters alone cut a two-chip row with 42px free; charging
 * them equally let two CJK names in and wrapped it.
 *
 * `[...text]` so a surrogate pair counts once. A formula, not a measurement —
 * swap in a real one only if a font change makes it wrong enough to wrap.
 */
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}]/u;

const chipWidth = (text: string) =>
  22 + [...text].reduce((w, ch) => w + (WIDE.test(ch) ? 11.5 : 5.2), 0);

/**
 * Tabs as the design draws them: no strip, split evenly, active one filled
 * with `accent`. The shared primitive's default is the inverse, and other
 * surfaces still use it as-is — hence the override here, not there.
 */
const TAB =
  "w-full justify-center rounded-md border-0 px-3 py-1.5 text-sm font-medium text-muted-foreground shadow-none " +
  "data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none";

function SelectionDot() {
  // The design marks the current row with a brand-orange dot on the right.
  // `aria-current` on the row carries the meaning; this is only its paint.
  return (
    <span
      aria-hidden="true"
      className="size-1.5 shrink-0 rounded-full bg-primary"
    />
  );
}

export function ServerPickerPanel({
  tab,
  onTabChange,
  servers,
  groups,
  selectedServerId = null,
  selectedGroupId = null,
  onSelectServer,
  onSelectGroup,
  onCreateGroup,
  deriveName,
  catalogKnown = true,
  busy = false,
  onDeleteGroup,
  canDeleteSelected = true,
  chipRoomPx = 200,
}: ServerPickerPanelProps) {
  // The draft is transient UI, not app state, so it lives here. The SELECTION
  // stays controlled by the caller — that is the part that persists.
  const fieldId = useId();
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  const [draftName, setDraftName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);

  /**
   * `draftIds` can outlive the rows it names — nothing closes the form when
   * `servers` changes — so every reader goes through this, or they disagree.
   */
  const draftServers = useMemo(
    () => servers.filter((s) => draftIds.has(s.id)),
    [servers, draftIds],
  );

  // Follows the picked servers until the user writes their own name.
  useEffect(() => {
    // Not while a submit is pending: the caller's write changes the names
    // already taken, which would re-derive this field past the row it just
    // wrote — and a kept draft carrying that name writes a duplicate.
    if (!showForm || nameEdited || submitting || !deriveName) return;
    setDraftName(deriveName(draftServers.map((s) => s.name)));
  }, [showForm, nameEdited, submitting, deriveName, draftServers]);

  const resetForm = () => {
    setShowForm(false);
    setSubmitting(false);
    setDraftIds(new Set());
    setDraftName("");
    setNameEdited(false);
  };
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => onTabChange(next as PickerTab)}
      className="gap-1"
    >
      <TabsList className="grid h-auto w-full grid-cols-2 gap-1 bg-transparent p-0">
        {/* `submitting` only — NOT `busy`. `busy` also means "still loading",
            and freezing navigation while data arrives is a worse answer than
            the overlap it would prevent: every row is already `disabled={busy}`,
            so nothing can be started from the other tab anyway. */}
        <TabsTrigger value="servers" className={TAB} disabled={submitting}>
          Servers
        </TabsTrigger>
        {/* Frozen while a create is in flight: leaving the tab mid-submit let
            a selection or a Connect start beside the write everything else is
            frozen for. */}
        <TabsTrigger value="groups" className={TAB} disabled={submitting}>
          Server Groups
        </TabsTrigger>
      </TabsList>

      <TabsContent value="servers" className="space-y-0.5">
        {servers.length === 0 ? (
          <p className="px-2 py-1.5 text-xs italic text-muted-foreground">
            {catalogKnown
              ? "No servers in this project yet."
              : "Loading servers…"}
          </p>
        ) : null}
        {servers.map((server) => {
          const selected = server.id === selectedServerId;
          return (
            <div key={server.id} className={ROW_WRAP}>
              <button
                type="button"
                onClick={() => onSelectServer(server.id)}
                disabled={busy}
                aria-current={selected ? "true" : undefined}
                className={cn(
                  ROW,
                  "min-w-0 flex-1 text-sm disabled:opacity-50",
                )}
              >
                <span
                  role="img"
                  aria-label={server.status.label}
                  data-testid={`server-status-dot-${server.id}`}
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    server.status.indicatorClassName,
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{server.name}</span>
              </button>
              {/* Sibling of the row, never nested inside it: a click here
                  connects and must not also commit a selection. */}
              {server.onConnect ? (
                <button
                  type="button"
                  // Named for the row: several rows can offer Connect, and a
                  // screen reader otherwise reads a list of identical buttons.
                  aria-label={`Connect ${server.name}`}
                  onClick={server.onConnect}
                  // `busy` freezes every other control in the panel, and this
                  // was the one that stayed live: a handshake could be started
                  // from a popover that was refusing all of its own actions.
                  disabled={busy}
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:underline disabled:opacity-50 disabled:no-underline"
                >
                  Connect
                </button>
              ) : null}
              {selected ? <SelectionDot /> : null}
            </div>
          );
        })}
      </TabsContent>

      <TabsContent value="groups" className="space-y-0.5">
        {showForm ? (
          <div className="space-y-3 p-1">
            <div className="space-y-1">
              <Label htmlFor={fieldId} className="text-[11px]">
                Group name
              </Label>
              <Input
                // The button that opened this form unmounts with it, dropping
                // focus to `<body>`. Keyboard and screen-reader users land on
                // the first thing they need instead.
                autoFocus
                id={fieldId}
                disabled={submitting || busy}
                value={draftName}
                onChange={(e) => {
                  setNameEdited(true);
                  setDraftName(e.target.value);
                }}
                placeholder="Name this group"
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">
                {`Servers (${draftServers.length} picked)`}
              </Label>
              {/* Scrolls internally so a long pool never pushes Create out of
                  reach — the reason the old picker resorted to committing on
                  click-away. Here only Create submits. */}
              <div
                role="group"
                aria-label="Pick servers for this group"
                className="max-h-48 space-y-0.5 overflow-y-auto pr-1"
              >
                {servers.map((server) => (
                  <Label
                    key={server.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm font-normal hover:bg-accent/30"
                  >
                    <Checkbox
                      checked={draftIds.has(server.id)}
                      disabled={submitting || busy}
                      aria-label={server.name}
                      onCheckedChange={(next) =>
                        setDraftIds((prev) => {
                          const copy = new Set(prev);
                          if (next === true) copy.add(server.id);
                          else copy.delete(server.id);
                          return copy;
                        })
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {server.name}
                    </span>
                  </Label>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-7 flex-1 text-xs"
                disabled={
                  draftServers.length === 0 ||
                  draftName.trim().length === 0 ||
                  submitting ||
                  busy
                }
                onClick={async () => {
                  setSubmitting(true);
                  try {
                    // Only ids still on offer: nothing closes this form when
                    // `servers` changes, so a draft can outlive the rows it
                    // was built from — and the derived name and the picked
                    // count already ignore the ones that went away.
                    await onCreateGroup(
                      draftName.trim(),
                      draftServers.map((s) => s.id),
                    );
                    resetForm();
                  } catch {
                    // The caller reports the reason; keep the draft so the
                    // user can fix the name instead of rebuilding it.
                    setSubmitting(false);
                  }
                }}
              >
                {submitting ? (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                ) : null}
                Create
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={submitting}
                onClick={resetForm}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        {showForm
          ? null
          : groups.map((group) => {
              const selected = group.id === selectedGroupId;
              // As many as FIT, per the design: two `excalidraw` chips and
              // `+4`, but three short names all show. A fixed count wrapped
              // the row. No ResizeObserver — the row is one line either way.
              const shown: string[] = [];
              let used = 0;
              for (const [i, name] of group.serverNames.entries()) {
                // `+N` takes room too, so each candidate has to leave space for
                // the summary that would follow it.
                const hidden = group.serverNames.length - i - 1;
                const next = used + chipWidth(name);
                if (
                  shown.length > 0 &&
                  next + (hidden > 0 ? chipWidth(`+${hidden}`) : 0) > chipRoomPx
                ) {
                  break;
                }
                shown.push(name);
                used = next;
              }
              const hidden = group.serverNames.length - shown.length;
              return (
                <div key={group.id} className={ROW_WRAP}>
                  <button
                    type="button"
                    onClick={() => onSelectGroup(group.id)}
                    disabled={busy}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      ROW,
                      "min-w-0 flex-1 flex-col !items-start gap-1 disabled:opacity-50",
                    )}
                  >
                    <span className="truncate text-sm">{group.name}</span>
                    <span className="flex flex-wrap items-center gap-1">
                      {shown.map((name, i) => (
                        <Badge key={`${group.id}-${i}`} className={CHIP}>
                          {name}
                        </Badge>
                      ))}
                      {hidden > 0 ? (
                        <Badge className={CHIP}>{`+${hidden}`}</Badge>
                      ) : null}
                    </span>
                  </button>
                  {selected ? <SelectionDot /> : null}
                  {onDeleteGroup && (canDeleteSelected || !selected) ? (
                    <button
                      type="button"
                      aria-label={`Delete ${group.name}`}
                      disabled={busy}
                      onClick={() => onDeleteGroup(group.id)}
                      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-destructive disabled:opacity-30"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  ) : null}
                </div>
              );
            })}
        {!showForm ? (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            // Also while the catalog is unknown: the form would open with no
            // servers to tick and a name derived from nothing.
            // …and with an answered but EMPTY catalog: the form would open
            // with nothing to tick and no submission possible.
            disabled={busy || !catalogKnown || servers.length === 0}
            className={cn(ROW, "text-sm hover:bg-accent disabled:opacity-50")}
          >
            <Plus className="size-3.5 shrink-0 text-muted-foreground" />
            <span>Create new group…</span>
          </button>
        ) : null}
      </TabsContent>
    </Tabs>
  );
}
