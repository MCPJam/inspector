/**
 * Recognizes a hosted guest coming back after time away, so the app can ask
 * them to create an account once per visit.
 *
 * A visit is a local calendar day with activity in this browser, so the
 * prompt shows at most once a day. The guest cookie lasts a year, so the
 * record lives in localStorage beside it rather than in the tab's
 * sessionStorage.
 */
import { track } from "@/lib/analytics";

const STORAGE_KEY = "mcpjam:returning-guest-v1";
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(time: number): number {
  const date = new Date(time);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/** Whole calendar days between two times; rounding absorbs DST shifts. */
function calendarDaysBetween(from: number, to: number): number {
  return Math.round((startOfLocalDay(to) - startOfLocalDay(from)) / DAY_MS);
}

interface GuestVisitRecord {
  lastActiveAt: number;
  visitStartedAt: number;
  visitCount: number;
  dialogClosedForVisit?: number;
}

export interface GuestVisit {
  visitNumber: number;
  visitStartedAt: number;
  isReturning: boolean;
  dialogClosed: boolean;
}

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
  };
  if (
    current &&
    current.visitNumber === next.visitNumber &&
    current.visitStartedAt === next.visitStartedAt &&
    current.dialogClosed === next.dialogClosed
  ) {
    return;
  }
  current = next;
  listeners.forEach((listener) => listener());
}

/** Records guest activity now, starting a new visit on a new calendar day. */
export function touchGuestVisit(now: number = Date.now()): void {
  const previous = readRecord();
  const isNewVisit =
    !previous || calendarDaysBetween(previous.lastActiveAt, now) > 0;
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
      days_since_last_visit: calendarDaysBetween(previous.lastActiveAt, now),
    });
  }
  publish(record);
}

/** Remembers, for the rest of this visit, that the guest closed the dialog. */
export function markGuestDialogClosed(): void {
  const record = readRecord();
  if (!record) return;
  const next = { ...record, dialogClosedForVisit: record.visitStartedAt };
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
