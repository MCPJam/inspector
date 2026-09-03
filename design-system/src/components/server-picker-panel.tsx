/**
 * The two-tab server picker panel.
 *
 * Servers and groups are SIBLING tabs, Servers first, and a group shows its
 * members as static chips: nothing here expands, which the tests assert.
 *
 * Purely presentational and fully controlled. It is handed a resolved
 * `{ label, indicatorColor }` per server rather than a connection status, so
 * it imports nothing from the app and needs no Convex mock to test.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";
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
  /** Resolved by the caller — the panel never maps a ConnectionStatus itself. */
  status: { label: string; indicatorColor: string };
  /**
   * Present only when connecting is offered for this row. Absence is how the
   * caller says "nothing to do here", so the panel needs no status rules of
   * its own to decide whether to show the action.
   */
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
  /**
   * Name to suggest for a draft holding these servers. Injected because the
   * rule depends on the project's existing names, which the panel does not
   * see — the caller passes `deriveServerGroupName` bound to them.
   */
  deriveName?: (pickedServerNames: string[]) => string;
  /**
   * Whether the server catalog has ANSWERED. `false` means unknown, which is
   * not the same as empty — claiming a project has no servers while its query
   * is still in flight is the defect this carries over from the picker it
   * replaces. Defaults true so a caller that already has rows says nothing.
   */
  catalogKnown?: boolean;
  /**
   * Chips shown before the rest collapse into `+N`.
   *
   * A COUNT, while the design's own overflow looks driven by the width of the
   * names it happens to hold. Width is not observable in jsdom, so a count is
   * the part that can be pinned by a test; the visual pass in a browser owns
   * the rest.
   */
  chipLimit?: number;
};

const ROW = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left";

/**
 * A group's member chip. `muted` rather than the Badge's `secondary`: both are
 * near-white in this theme, but `muted` is the lighter of the two, which is the
 * weight the design gives them. Fully rounded, also per the design.
 */
const CHIP =
  "rounded-full border-transparent bg-muted px-2 py-0 text-[11px] font-normal text-muted-foreground";

/**
 * Tabs as the design draws them: no container strip, the two split evenly
 * across the popover with their labels centred, and the ACTIVE one filled with
 * `accent` (the light neutral) while the other is plain text. The design
 * system's default is the inverse — a muted strip with the active tab in white,
 * packed left — so both halves are overridden here rather than in the shared
 * primitive, which other surfaces still use as-is.
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
  chipLimit = 3,
}: ServerPickerPanelProps) {
  // The draft is transient UI, not app state, so it lives here. The SELECTION
  // stays controlled by the caller — that is the part that persists.
  const fieldId = useId();
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  const [draftName, setDraftName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);

  const draftNames = useMemo(
    () => servers.filter((s) => draftIds.has(s.id)).map((s) => s.name),
    [servers, draftIds],
  );

  // Follows the picked servers until the user writes their own name.
  useEffect(() => {
    if (!showForm || nameEdited || !deriveName) return;
    setDraftName(deriveName(draftNames));
  }, [showForm, nameEdited, deriveName, draftNames]);

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
        <TabsTrigger value="servers" className={TAB}>
          Servers
        </TabsTrigger>
        <TabsTrigger value="groups" className={TAB}>
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
            <div
              key={server.id}
              className="group flex items-center gap-1 rounded pr-1 hover:bg-accent"
            >
              <button
                type="button"
                onClick={() => onSelectServer(server.id)}
                aria-current={selected ? "true" : undefined}
                className={cn(ROW, "min-w-0 flex-1 text-sm")}
              >
                <span
                  role="img"
                  aria-label={server.status.label}
                  data-testid={`server-status-dot-${server.id}`}
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: server.status.indicatorColor }}
                />
                <span className="min-w-0 flex-1 truncate">{server.name}</span>
              </button>
              {/* Sibling of the row, never nested inside it: a click here
                  connects and must not also commit a selection. */}
              {server.onConnect ? (
                <button
                  type="button"
                  onClick={server.onConnect}
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:underline"
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
                id={fieldId}
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
                {`Servers (${draftIds.size} picked)`}
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
                  draftIds.size === 0 ||
                  draftName.trim().length === 0 ||
                  submitting
                }
                onClick={async () => {
                  setSubmitting(true);
                  try {
                    await onCreateGroup(draftName.trim(), Array.from(draftIds));
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
        {showForm ? null : groups.map((group) => {
          const selected = group.id === selectedGroupId;
          const shown = group.serverNames.slice(0, chipLimit);
          const hidden = group.serverNames.length - shown.length;
          return (
            <div
              key={group.id}
              className="flex items-center gap-1 rounded pr-1 hover:bg-accent"
            >
              <button
                type="button"
                onClick={() => onSelectGroup(group.id)}
                aria-current={selected ? "true" : undefined}
                className={cn(ROW, "min-w-0 flex-1 flex-col !items-start gap-1")}
              >
                <span className="truncate text-sm">{group.name}</span>
                <span className="flex flex-wrap items-center gap-1">
                  {shown.map((name, i) => (
                    <Badge
                      key={`${group.id}-${i}`}
                      className={CHIP}
                    >
                      {name}
                    </Badge>
                  ))}
                  {hidden > 0 ? (
                    <Badge className={CHIP}>{`+${hidden}`}</Badge>
                  ) : null}
                </span>
              </button>
              {selected ? <SelectionDot /> : null}
            </div>
          );
        })}
        {!showForm ? (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className={cn(ROW, "text-sm hover:bg-accent")}
          >
            <Plus className="size-3.5 shrink-0 text-muted-foreground" />
            <span>Create new group…</span>
          </button>
        ) : null}
      </TabsContent>
    </Tabs>
  );
}
