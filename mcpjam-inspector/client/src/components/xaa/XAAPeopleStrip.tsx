import { useEffect, useId, useState } from "react";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { CharacterAvatar } from "@/components/chatboxes/personas";
import {
  useXaaPeopleMutations,
  type RemoteXaaPerson,
} from "@/hooks/useXaaPeople";
import { cn } from "@/lib/utils";

/** Per-person result of the last valid run against the current target,
 * as ruled by the resource authorization server (jwt-bearer redemption).
 * Deliberately not a boolean: "complete" doesn't prove full access (the AS
 * may downscope), and not every failure is a policy denial. */
export interface XaaPersonOutcome {
  status: "allowed" | "ras_rejected" | "ras_downscoped" | "test_error";
  /** Allowlisted OAuth error code (never a raw error string). */
  oauthErrorCode?: string;
  failedStep?: string;
}

function OutcomeBadge({ outcome }: { outcome: XaaPersonOutcome }) {
  switch (outcome.status) {
    case "allowed":
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
          <Check className="size-3" /> Allowed
        </span>
      );
    case "ras_downscoped":
      return (
        <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
          Downscoped
        </span>
      );
    case "ras_rejected":
      return (
        <span className="text-[11px] font-medium text-destructive">
          Rejected{outcome.oauthErrorCode ? ` · ${outcome.oauthErrorCode}` : ""}
        </span>
      );
    case "test_error":
      return (
        <span
          className="text-[11px] font-medium text-muted-foreground"
          title="The run failed before a policy ruling on this subject — not a policy result."
        >
          Error{outcome.failedStep ? ` · ${outcome.failedStep}` : ""}
        </span>
      );
  }
}

export interface PersonDraft {
  name: string;
  subject: string;
  email: string;
}

export const EMPTY_PERSON_DRAFT: PersonDraft = {
  name: "",
  subject: "",
  email: "",
};

/**
 * Add/edit form shared by the "+" popover and the per-chip edit popover.
 */
export function PersonForm({
  initial,
  personId,
  projectId,
  onDone,
  onDeleted,
}: {
  initial: PersonDraft;
  /** Present = edit; absent = create. */
  personId?: string;
  projectId: string;
  onDone: () => void;
  onDeleted?: () => void;
}) {
  const { create, update, remove } = useXaaPeopleMutations();
  const [draft, setDraft] = useState<PersonDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Per-instance field IDs: the add and edit forms can be mounted at the same
  // time (add popover opened over an open edit popover), and shared static IDs
  // would let one form's label focus the other form's input.
  const fieldId = useId();

  const canSave =
    draft.name.trim().length > 0 &&
    draft.subject.trim().length > 0 &&
    draft.email.trim().length > 0;

  const submit = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (personId) {
        await update({
          testIdentityId: personId,
          name: draft.name,
          subject: draft.subject,
          email: draft.email,
        });
      } else {
        await create({
          projectId,
          name: draft.name,
          subject: draft.subject,
          email: draft.email,
        });
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save this identity");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!personId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await remove({ testIdentityId: personId });
      onDeleted?.();
      onDone();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't delete this identity"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${fieldId}-name`} className="text-xs">
          Name
        </Label>
        <Input
          id={`${fieldId}-name`}
          value={draft.name}
          placeholder="Test admin"
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${fieldId}-subject`} className="text-xs">
          Subject (<code className="font-mono">sub</code> claim)
        </Label>
        <Input
          id={`${fieldId}-subject`}
          value={draft.subject}
          placeholder="test-user-1"
          className="font-mono"
          onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${fieldId}-email`} className="text-xs">
          Email
        </Label>
        <Input
          id={`${fieldId}-email`}
          value={draft.email}
          placeholder="test-user-1@example.test"
          className="font-mono"
          onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
        />
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center justify-between gap-2">
        {personId ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => void handleDelete()}
          >
            <Trash2 className="size-3.5" />
            Delete
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" size="sm" disabled={!canSave || busy}>
          {personId ? "Save" : "Add person"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Slim "Run as" strip under the IdP bar: one chip per synthetic test identity.
 * Selecting a person makes the flow mint assertions for their subject/email;
 * the badge is the last policy decision about them against the current target.
 *
 * Invisible-ish by design: renders nothing when the roster is unavailable
 * (signed out / no project) or still loading, and only a small ghost button
 * when the roster is empty — an empty roster leaves the debugger exactly as
 * it was before this feature.
 */
/**
 * The "Run as… / Add person" trigger and its add-person popover. Extracted so
 * it can sit in the IdP card header next to the identity-assertion toggle,
 * separate from the roster chips. Owns its own popover state; renders nothing
 * when there is no project to attach an identity to.
 */
export function AddPersonButton({
  projectId,
  peopleCount,
}: {
  projectId: string | null;
  peopleCount: number;
}) {
  const [adding, setAdding] = useState(false);
  if (!projectId) return null;
  return (
    <Popover open={adding} onOpenChange={setAdding}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
        >
          <Plus className="size-3.5" />
          {peopleCount === 0 ? "Run as…" : "Add person"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <PersonForm
          initial={EMPTY_PERSON_DRAFT}
          projectId={projectId}
          onDone={() => setAdding(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

export function XAAPeopleStrip({
  people,
  isLoading,
  isAvailable,
  projectId,
  selectedPersonId,
  onSelectPerson,
  disabled,
  outcomeFor,
}: {
  people: RemoteXaaPerson[] | undefined;
  isLoading: boolean;
  isAvailable: boolean;
  projectId: string | null;
  selectedPersonId: string | null;
  onSelectPerson: (personId: string | null) => void;
  /** True while a run is busy — switching identities mid-run could reuse an
   * assertion minted for the previous person. */
  disabled: boolean;
  outcomeFor: (personId: string) => XaaPersonOutcome | undefined;
}) {
  const { remove } = useXaaPeopleMutations();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // If the roster shrinks under an open edit popover, close it.
  useEffect(() => {
    if (editingId && !people?.some((p) => p._id === editingId)) {
      setEditingId(null);
    }
  }, [editingId, people]);

  if (!isAvailable || isLoading || people === undefined || !projectId) {
    return null;
  }

  // Loaded-and-empty: the add button now lives in the IdP card header, so the
  // strip itself renders nothing until there is at least one identity chip.
  if (people.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-4 py-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        Run as
      </span>
      {people.map((person) => {
        const selected = person._id === selectedPersonId;
        const outcome = outcomeFor(person._id);
        const chipBusy = disabled || removingId === person._id;
        return (
          <div
            key={person._id}
            className={cn(
              "group/chip flex items-center rounded-full border py-1 pl-1 pr-1 transition-colors",
              selected
                ? "border-primary/60 bg-primary/5 ring-1 ring-primary/40"
                : "border-border/60 hover:bg-muted/40",
              chipBusy && "opacity-60",
            )}
          >
            <button
              type="button"
              aria-pressed={selected}
              aria-disabled={chipBusy || undefined}
              title={`${person.subject} · ${person.email}`}
              onClick={() => {
                if (chipBusy) return;
                onSelectPerson(selected ? null : person._id);
              }}
              className={cn(
                "flex items-center gap-2 rounded-full py-0 pl-0 pr-2 text-left",
                chipBusy && "cursor-not-allowed",
              )}
            >
              <CharacterAvatar name={person.name} seed={person._id} size="sm" />
              <span className="text-xs font-medium">{person.name}</span>
              {outcome ? <OutcomeBadge outcome={outcome} /> : null}
            </button>
            <div className="flex items-center border-l border-border/60 pl-0.5">
              <Popover
                // Same run-in-progress guard as chip switching: editing or
                // deleting a person mid-run would mutate/deselect the running
                // identity through the back door the disabled chips close.
                open={!chipBusy && editingId === person._id}
                onOpenChange={(open) => {
                  if (chipBusy) return;
                  setEditingId(open ? person._id : null);
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Edit ${person.name}`}
                    aria-disabled={chipBusy || undefined}
                    title={`Edit ${person.name}`}
                    className={cn(
                      "rounded-full p-1.5 text-muted-foreground transition-colors",
                      chipBusy
                        ? "cursor-not-allowed"
                        : "hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80">
                  <PersonForm
                    initial={{
                      name: person.name,
                      subject: person.subject,
                      email: person.email,
                    }}
                    personId={person._id}
                    projectId={projectId}
                    onDone={() => setEditingId(null)}
                    onDeleted={() => {
                      if (selected) onSelectPerson(null);
                    }}
                  />
                </PopoverContent>
              </Popover>
              <button
                type="button"
                aria-label={`Remove ${person.name}`}
                aria-disabled={chipBusy || undefined}
                title={`Remove ${person.name}`}
                disabled={chipBusy}
                onClick={() => {
                  if (chipBusy) return;
                  setRemovingId(person._id);
                  void remove({ testIdentityId: person._id })
                    .then(() => {
                      if (selected) onSelectPerson(null);
                      if (editingId === person._id) setEditingId(null);
                    })
                    .finally(() => {
                      setRemovingId((current) =>
                        current === person._id ? null : current,
                      );
                    });
                }}
                className={cn(
                  "rounded-full p-1.5 text-muted-foreground transition-colors",
                  chipBusy
                    ? "cursor-not-allowed"
                    : "hover:bg-destructive/10 hover:text-destructive",
                )}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
