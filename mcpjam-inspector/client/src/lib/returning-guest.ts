/**
 * Recognizes a hosted guest coming back after time away, so the app can ask
 * them to create an account once per visit.
 *
 * A visit starts when the guest has been inactive for more than
 * `GUEST_VISIT_GAP_MS` in this browser (the same 30 minutes PostHog uses to
 * split sessions). The guest cookie lasts a year, so the record lives in
 * localStorage beside it rather than in the tab's sessionStorage.
 */
import { track } from "@/lib/analytics";

const STORAGE_KEY = "mcpjam:returning-guest-v1";
export const GUEST_VISIT_GAP_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface GuestVisitRecord {
  lastActiveAt: number;
  visitStartedAt: number;
  visitCount: number;
  dialogClosedForVisit?: number;
  noticeDismissedForVisit?: number;
}

export interface GuestVisit {
  visitNumber: number;
  visitStartedAt: number;
  isReturning: boolean;
  dialogClosed: boolean;
  noticeDismissed: boolean;
}

type VisitMark = "dialogClosedForVisit" | "noticeDismissedForVisit";

let current: GuestVisit | null = null;
const listeners = new Set<() => void>();

function readRecord(): GuestVisitRecord | null {
  let parsed: Partial<GuestVisitRecord> | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    parsed = raw ? (JSON.parse(raw) as Partial<GuestVisitRecord>) : null;
  } catch {
    // Unreadable or corrupt: treat it as a first visit.
    return null;
  }
  if (
    typeof parsed?.lastActiveAt !== "number" ||
    typeof parsed.visitStartedAt !== "number" ||
    typeof parsed.visitCount !== "number"
  ) {
    return null;
  }
  return parsed as GuestVisitRecord;
}

function writeRecord(record: GuestVisitRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable: the prompt still shows, it just can't remember.
  }
}

function publish(record: GuestVisitRecord): void {
  const next: GuestVisit = {
    visitNumber: record.visitCount,
    visitStartedAt: record.visitStartedAt,
    isReturning: record.visitCount > 1,
    dialogClosed: record.dialogClosedForVisit === record.visitStartedAt,
    noticeDismissed: record.noticeDismissedForVisit === record.visitStartedAt,
  };
  if (
    current &&
    current.visitNumber === next.visitNumber &&
    current.visitStartedAt === next.visitStartedAt &&
    current.dialogClosed === next.dialogClosed &&
    current.noticeDismissed === next.noticeDismissed
  ) {
    return;
  }
  current = next;
  listeners.forEach((listener) => listener());
}

/** Records guest activity now, starting a new visit after a long enough gap. */
export function touchGuestVisit(now: number = Date.now()): void {
  const previous = readRecord();
  const isNewVisit =
    !previous || now - previous.lastActiveAt > GUEST_VISIT_GAP_MS;
  const record: GuestVisitRecord = isNewVisit
    ? {
        lastActiveAt: now,
        visitStartedAt: now,
        visitCount: (previous?.visitCount ?? 0) + 1,
      }
    : { ...previous, lastActiveAt: now };
  writeRecord(record);
  if (isNewVisit && previous) {
    track("returning_guest_detected", {
      visit_number: record.visitCount,
      days_since_last_visit: Math.floor((now - previous.lastActiveAt) / DAY_MS),
    });
  }
  publish(record);
}

/** Remembers, for the rest of this visit, that the guest closed a prompt. */
export function markGuestVisit(mark: VisitMark): void {
  const record = readRecord();
  if (!record) return;
  const next = { ...record, [mark]: record.visitStartedAt };
  writeRecord(next);
  publish(next);
}

export function getGuestVisit(): GuestVisit | null {
  return current;
}

export function subscribeGuestVisit(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: forget the in-memory visit between cases. */
export function resetGuestVisitForTests(): void {
  current = null;
}
