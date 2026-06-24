/**
 * Phase 2 — the Personas tab (`/chatboxes` → Personas).
 *
 * Character-select grid over the chatbox's durable persona roster, with:
 *   - "New character" (hand-authored persona)
 *   - "Seed from traffic" chips wired to the chatbox's theme clusters
 *   - "Run swarm" — launches synthetic sessions for the selected personas
 *     (opens the shared GenerateSessionsDialog pre-seeded)
 *   - a track-record panel surfacing Phase 1 readiness aggregates per persona
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { toast } from "@/lib/toast";
import { Loader2, Plus, Sparkles, Users } from "lucide-react";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import {
  PersonaCard,
  PersonaTrackRecordPanel,
  usePersonaMutations,
  usePersonaRoster,
  useSortedRoster,
  type PersonaSlate,
  type RosterPersona,
} from "@/components/chatboxes/personas";
import { GenerateSessionsDialog } from "@/components/chatboxes/GenerateSessionsDialog";

interface ClusterSummary {
  _id: string;
  label: string;
  summary?: string;
  keywords?: string[];
  memberCount?: number;
}

// Mirrors the backend MAX_PERSONA_COUNT (and the /start `.max(10)` validator):
// a single run accepts at most this many personas.
const MAX_RUN_PERSONAS = 10;

export function PersonasTab({ chatbox }: { chatbox: ChatboxSettings }) {
  const roster = useSortedRoster(usePersonaRoster(chatbox.chatboxId));
  const { create, seedFromClusters } = usePersonaMutations();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [seeding, setSeeding] = useState(false);

  // Selection/focus are per-chatbox; clear them on a chatbox switch so the
  // track-record panel never renders a persona from the previous chatbox.
  useEffect(() => {
    setSelectedIds(new Set());
    setFocusedId(null);
  }, [chatbox.chatboxId]);

  const clusterData = useQuery(
    "chatSessions:listClustersByChatbox" as any,
    { chatboxId: chatbox.chatboxId } as any
  ) as { clusters: ClusterSummary[] } | null | undefined;

  // Clusters that have not yet seeded a live persona — the seed-from-traffic
  // chips. seedThemeClusterId on the roster marks the ones already used.
  const seededClusterIds = useMemo(
    () =>
      new Set(
        (roster ?? [])
          .map((p) => p.seedThemeClusterId)
          .filter((id): id is string => Boolean(id))
      ),
    [roster]
  );
  const seedableClusters = (clusterData?.clusters ?? []).filter(
    (c) => !seededClusterIds.has(c._id)
  );

  const toggleSelect = useCallback((persona: RosterPersona) => {
    setFocusedId(persona._id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(persona._id)) next.delete(persona._id);
      else next.add(persona._id);
      return next;
    });
  }, []);

  const selectedPersonas = useMemo(
    () => (roster ?? []).filter((p) => selectedIds.has(p._id)),
    [roster, selectedIds]
  );

  const selectedSlates: PersonaSlate[] = useMemo(
    () =>
      selectedPersonas.map((p) => ({
        id: p.personaId,
        name: p.name,
        role: p.role,
        notes: p.notes,
        // Thread durable identity + objective so the run pursues/grades the
        // goal and the synthetic session is stamped with the durable ref.
        ...(p.goal ? { goal: p.goal } : {}),
        personaRefId: p._id,
      })),
    [selectedPersonas]
  );

  const handleSeedCluster = useCallback(
    async (clusterId: string) => {
      setSeeding(true);
      try {
        const result = (await seedFromClusters({
          chatboxId: chatbox.chatboxId,
          clusterIds: [clusterId],
        } as any)) as { createdCount: number };
        if (result.createdCount > 0) {
          toast.success(`Added ${result.createdCount} character from traffic`);
        } else {
          toast.info("That theme already has a character");
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to seed character"
        );
      } finally {
        setSeeding(false);
      }
    },
    [seedFromClusters, chatbox.chatboxId]
  );

  return (
    <div className="flex h-full flex-col">
      <NewCharacterDialog
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={async (draft) => {
          await create({ chatboxId: chatbox.chatboxId, ...draft } as any);
        }}
      />
      <GenerateSessionsDialog
        isOpen={runOpen}
        onClose={() => setRunOpen(false)}
        chatbox={chatbox}
        initialPersonas={selectedSlates}
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-full"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="mr-1 size-3" />
          New character
        </Button>
        {seedableClusters.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              Seed from traffic:
            </span>
            {seedableClusters.slice(0, 6).map((cluster) => (
              <button
                key={cluster._id}
                type="button"
                disabled={seeding}
                onClick={() => void handleSeedCluster(cluster._id)}
                className="inline-flex max-w-[160px] items-center gap-1 truncate rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
              >
                <Sparkles className="size-2.5 shrink-0" />
                <span className="truncate">{cluster.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {selectedPersonas.length > MAX_RUN_PERSONAS ? (
            <span className="text-[11px] text-amber-600 dark:text-amber-400">
              Select at most {MAX_RUN_PERSONAS}
            </span>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="rounded-full"
            disabled={
              selectedPersonas.length === 0 ||
              selectedPersonas.length > MAX_RUN_PERSONAS
            }
            onClick={() => setRunOpen(true)}
            title={
              selectedPersonas.length > MAX_RUN_PERSONAS
                ? `A run accepts at most ${MAX_RUN_PERSONAS} personas`
                : undefined
            }
          >
            <Sparkles className="mr-1 size-3" />
            Run swarm
            {selectedPersonas.length > 0 ? ` (${selectedPersonas.length})` : ""}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={62} minSize={40}>
            <PersonaGrid
              roster={roster}
              selectedIds={selectedIds}
              onToggle={toggleSelect}
              onNew={() => setCreateOpen(true)}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={38} minSize={24}>
            <PersonaTrackRecordPanel personaRefId={focusedId} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

function PersonaGrid({
  roster,
  selectedIds,
  onToggle,
  onNew,
}: {
  roster: RosterPersona[] | undefined;
  selectedIds: Set<string>;
  onToggle: (persona: RosterPersona) => void;
  onNew: () => void;
}) {
  if (roster === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  if (roster.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Users className="size-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          No characters yet. Create one or seed from your chatbox traffic.
        </p>
        <Button size="sm" variant="outline" onClick={onNew}>
          <Plus className="mr-1 size-3" />
          New character
        </Button>
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
        {roster.map((persona) => (
          <PersonaCard
            key={persona._id}
            persona={persona}
            selected={selectedIds.has(persona._id)}
            onToggle={() => onToggle(persona)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function NewCharacterDialog({
  isOpen,
  onClose,
  onCreate,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (draft: {
    name: string;
    role: string;
    notes: string;
    goal: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [notes, setNotes] = useState("");
  const [goal, setGoal] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName("");
    setRole("");
    setNotes("");
    setGoal("");
  };

  // Clear the draft whenever the dialog closes (Cancel or dismiss), so
  // reopening "New character" always starts from an empty form.
  useEffect(() => {
    if (!isOpen) {
      setName("");
      setRole("");
      setNotes("");
      setGoal("");
    }
  }, [isOpen]);

  const handleSave = async () => {
    if (!name.trim() || !role.trim()) {
      toast.error("Name and role are required");
      return;
    }
    setSaving(true);
    try {
      await onCreate({
        name: name.trim(),
        role: role.trim(),
        notes: notes.trim(),
        goal: goal.trim(),
      });
      toast.success("Character added");
      reset();
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to add character"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New character</DialogTitle>
          <DialogDescription>
            A reusable synthetic user this swarm can role-play.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="persona-name">Name</Label>
            <Input
              id="persona-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Curious First-Time User"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="persona-role">Role</Label>
            <Input
              id="persona-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="Evaluating the product for their team"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="persona-goal">Goal</Label>
            <Input
              id="persona-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What they're trying to accomplish (graded later)"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="persona-notes">Notes</Label>
            <Textarea
              id="persona-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Background, context, what they'll try…"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            Add character
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
