import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";

/**
 * Where extension forms meet the composer.
 *
 * Form owners (the legacy owned-form host and the hosted MRTR rail) register
 * each pending request against the plugin workspace of the chat it belongs to.
 * A composer for that workspace registers a slot element. The earliest
 * registered request for a workspace is the active one: its owner portals the
 * form card into the slot, every later request waits its turn, and the
 * composer hides itself (keeping its draft) while any request is pending.
 *
 * Workspaces are per chat, so switching chats leaves a request pending on its
 * own chat and shows it again on return.
 */
export interface ComposerFormEntry {
  id: string;
  workspaceId: string;
  serverName: string;
  /** Arrival order across every form source. */
  order: number;
}

interface ComposerSlot {
  workspaceId: string;
  element: HTMLElement;
  seq: number;
}

interface ComposerFormState {
  forms: ComposerFormEntry[];
  slots: ComposerSlot[];
}

export const useComposerFormStore = create<ComposerFormState>(() => ({
  forms: [],
  slots: [],
}));

let sequence = 0;
/** Arrival order survives StrictMode's unregister/register replay. */
const arrival = new Map<string, number>();
const cancels = new Map<string, () => unknown>();
const cancelled = new Set<string>();

function arrivalOrder(id: string) {
  let order = arrival.get(id);
  if (order === undefined) {
    order = ++sequence;
    arrival.set(id, order);
    // Bounded: only the most recent identities need a stable position.
    if (arrival.size > 1024) {
      const oldest = arrival.keys().next().value;
      if (oldest !== undefined) arrival.delete(oldest);
    }
  }
  return order;
}

export function registerComposerForm(input: {
  id: string;
  workspaceId: string;
  serverName: string;
  cancel: () => unknown;
}): () => void {
  const entry: ComposerFormEntry = {
    id: input.id,
    workspaceId: input.workspaceId,
    serverName: input.serverName,
    order: arrivalOrder(input.id),
  };
  cancels.set(input.id, input.cancel);
  useComposerFormStore.setState((state) => ({
    forms: [...state.forms.filter((form) => form.id !== input.id), entry],
  }));
  return () => {
    if (cancels.get(input.id) === input.cancel) cancels.delete(input.id);
    useComposerFormStore.setState((state) =>
      state.forms.some((form) => form === entry)
        ? { forms: state.forms.filter((form) => form !== entry) }
        : state,
    );
  };
}

export function registerComposerSlot(
  workspaceId: string,
  element: HTMLElement,
): () => void {
  const slot = { workspaceId, element, seq: ++sequence };
  useComposerFormStore.setState((state) => ({
    slots: [...state.slots, slot],
  }));
  return () =>
    useComposerFormStore.setState((state) => ({
      slots: state.slots.filter((value) => value !== slot),
    }));
}

/**
 * Closing a chat or ending its run cancels each of its pending forms once.
 * A request that is already being cancelled is never cancelled again.
 */
export function cancelComposerForms(workspaceId: string): void {
  for (const form of useComposerFormStore.getState().forms) {
    if (form.workspaceId !== workspaceId || cancelled.has(form.id)) continue;
    cancelled.add(form.id);
    try {
      void Promise.resolve(cancels.get(form.id)?.()).catch(() => {});
    } catch {
      // The owner keeps its own retry path; cancellation is best effort here.
    }
  }
}

export function sortedWorkspaceForms(
  forms: readonly ComposerFormEntry[],
  workspaceId: string | undefined,
) {
  return workspaceId
    ? forms
        .filter((form) => form.workspaceId === workspaceId)
        .sort((a, b) => a.order - b.order)
    : [];
}

/** Every pending form for a chat, in arrival order. */
export function useComposerForms(workspaceId: string | undefined) {
  const forms = useComposerFormStore((state) => state.forms);
  return useMemo(
    () => sortedWorkspaceForms(forms, workspaceId),
    [forms, workspaceId],
  );
}

/** The most recently mounted composer slot for a chat. */
export function useComposerSlot(workspaceId: string | undefined) {
  return useComposerFormStore((state) => {
    if (!workspaceId) return null;
    let latest: ComposerSlot | null = null;
    for (const slot of state.slots)
      if (
        slot.workspaceId === workspaceId &&
        (!latest || slot.seq > latest.seq)
      )
        latest = slot;
    return latest?.element ?? null;
  });
}

/** Register one pending request while it is live. */
export function useComposerFormRegistration(
  input: {
    id: string;
    workspaceId: string | undefined;
    serverName: string;
    cancel: () => unknown;
  } | null,
) {
  const cancel = useRef(input?.cancel);
  cancel.current = input?.cancel;
  const id = input?.id;
  const workspaceId = input?.workspaceId;
  const serverName = input?.serverName ?? "";
  useEffect(() => {
    if (!id || !workspaceId) return;
    return registerComposerForm({
      id,
      workspaceId,
      serverName,
      cancel: () => cancel.current?.(),
    });
  }, [id, workspaceId, serverName]);
  const forms = useComposerForms(workspaceId);
  return {
    /** First in line for its chat. */
    active: !!id && forms[0]?.id === id,
    /** True once the store knows about this request. */
    registered: !!id && forms.some((form) => form.id === id),
  };
}

/**
 * Unfinished answers, kept per request while its card is not shown (another
 * chat is selected, or the composer remounted). A pending form stays with its
 * chat, and so does what was typed into it. Not reactive: a card reads its
 * draft once when it mounts.
 */
export interface ComposerFormDraft {
  /** The request's compiled schema, so a draft never meets another form. */
  schema: string;
  values: Record<string, unknown>;
  step: number;
  skipped: readonly string[];
}
const drafts = new Map<string, ComposerFormDraft>();
const DRAFT_LIMIT = 64;

export function readComposerFormDraft(
  id: string,
  schema: string,
): ComposerFormDraft | undefined {
  const draft = drafts.get(id);
  return draft?.schema === schema ? draft : undefined;
}

export function writeComposerFormDraft(id: string, draft: ComposerFormDraft) {
  drafts.delete(id);
  drafts.set(id, draft);
  // Bounded: only the most recent unfinished forms keep their answers.
  while (drafts.size > DRAFT_LIMIT) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

export function clearComposerFormDraft(id: string) {
  drafts.delete(id);
}

/** Test-only reset. */
export function __resetComposerFormStore() {
  useComposerFormStore.setState({ forms: [], slots: [] });
  arrival.clear();
  cancels.clear();
  cancelled.clear();
  drafts.clear();
  sequence = 0;
}
