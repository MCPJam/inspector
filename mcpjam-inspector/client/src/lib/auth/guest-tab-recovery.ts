import {
  projectTransitionRecovery,
  currentProjectTransitionPath,
} from "./project-transition-recovery";
import { authCorrelationId } from "./correlation-id";
import { flushSync } from "react-dom";
import { createStore } from "zustand/vanilla";

const CHANNEL = "mcpjam.guest-transition.v1";
const RELOAD_KEY = `${CHANNEL}.reloaded`;
const HANDLED_KEY = `${CHANNEL}.handled`;
export const GUEST_RECOVERY_TIMEOUT_MS = 15_000;
const MAX_AGE_MS = 60_000;
type Phase = "started" | "completed" | "failed";
export type GuestTransition = {
  guestId: string;
  attempt: string;
  startedAt: number;
  phase: Phase;
};
type Recovery = {
  status: "idle" | "waiting" | "failed";
  attempt: string | null;
};

/** Messages contain an opaque guest scope, never a bearer token or profile. */
function parse(value: unknown): GuestTransition | null {
  if (!value || typeof value !== "object") return null;
  const m = value as GuestTransition;
  if (
    typeof m.guestId !== "string" ||
    !m.guestId ||
    m.guestId.length > 200 ||
    typeof m.attempt !== "string" ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(m.attempt) ||
    !Number.isFinite(m.startedAt) ||
    m.startedAt > Date.now() + 1000 ||
    Date.now() - m.startedAt > MAX_AGE_MS ||
    !["started", "completed", "failed"].includes(m.phase)
  )
    return null;
  return {
    guestId: m.guestId,
    attempt: m.attempt,
    startedAt: m.startedAt,
    phase: m.phase,
  };
}

export function createGuestTabRecovery(deps: {
  publish: (message: GuestTransition) => void;
  reload: () => void;
  allowAutomaticReload: () => boolean;
  beforeTransition?: (message: GuestTransition) => void;
}) {
  const store = createStore<Recovery>(() => ({
    status: "idle",
    attempt: null,
  }));
  // Session storage survives reloads without consuming another tab's message.
  // Retain only IDs whose transitions can still pass the age check.
  const handled = new Map<string, number>();
  try {
    const saved: unknown = JSON.parse(
      sessionStorage.getItem(HANDLED_KEY) ?? "[]",
    );
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          /^[a-zA-Z0-9-]{1,80}$/.test(entry[0]) &&
          Number.isFinite(entry[1]) &&
          entry[1] <= Date.now() + 1000 &&
          Date.now() - entry[1] <= MAX_AGE_MS
        ) {
          handled.set(entry[0], entry[1]);
        }
      }
    }
  } catch {
    /* Keep in-memory protection when storage is unavailable. */
  }
  const markHandled = (message: GuestTransition) => {
    for (const [id, at] of handled) {
      if (Date.now() - at > MAX_AGE_MS) handled.delete(id);
    }
    handled.set(message.attempt, message.startedAt);
    try {
      sessionStorage.setItem(HANDLED_KEY, JSON.stringify([...handled]));
    } catch {
      /* Recovery must not depend on storage. */
    }
  };
  let guestId: string | null = null;
  let current: GuestTransition | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sent = new Map<
    string,
    { message: GuestTransition; count: number; failed: boolean }
  >();
  const reset = () => {
    clearTimeout(timer);
    current = null;
    store.setState({ status: "idle", attempt: null });
  };
  const fail = () => {
    clearTimeout(timer);
    store.setState({ status: "failed" });
  };
  const reload = (automatic: boolean) => {
    if (automatic && !deps.allowAutomaticReload()) {
      fail();
      return;
    }
    store.setState({ status: "waiting" });
    clearTimeout(timer);
    timer = setTimeout(fail, GUEST_RECOVERY_TIMEOUT_MS);
    try {
      deps.reload();
    } catch {
      fail();
    }
  };
  const receive = (value: unknown) => {
    const message = parse(value);
    if (
      !message ||
      !guestId ||
      message.guestId !== guestId ||
      handled.has(message.attempt)
    )
      return;
    if (
      current &&
      (message.startedAt < current.startedAt ||
        (message.startedAt === current.startedAt &&
          message.attempt !== current.attempt))
    )
      return;
    if (current?.attempt === message.attempt && current.phase !== "started")
      return;
    deps.beforeTransition?.(message);
    current = message;
    clearTimeout(timer);
    store.setState({ status: "waiting", attempt: message.attempt });
    if (message.phase === "failed") {
      fail();
      markHandled(message);
    } else if (message.phase === "completed") {
      // Persist before navigation can discard this module's memory.
      markHandled(message);
      reload(true);
    } else
      timer = setTimeout(
        () => {
          fail();
          markHandled(message);
        },
        Math.max(
          0,
          GUEST_RECOVERY_TIMEOUT_MS - (Date.now() - message.startedAt),
        ),
      );
  };
  return {
    store,
    setGuest(id: string | null, replacementReady = true) {
      if (id !== guestId) {
        guestId = id;
        const wasBlocked = store.getState().status !== "idle";
        clearTimeout(timer);
        current = null; // Late messages/callbacks belong to the previous actor.
        if (wasBlocked && !replacementReady) {
          store.setState({ status: "waiting", attempt: null });
          timer = setTimeout(fail, GUEST_RECOVERY_TIMEOUT_MS);
        } else reset();
      } else if (
        !current &&
        replacementReady &&
        store.getState().status !== "idle"
      ) {
        reset();
      }
    },
    getGuest: () => guestId,
    receive,
    begin(id: string) {
      let entry = sent.get(id);
      if (!entry) {
        entry = {
          message: {
            guestId: id,
            attempt: authCorrelationId(),
            startedAt: Date.now(),
            phase: "started",
          },
          count: 0,
          failed: false,
        };
        sent.set(id, entry);
        try {
          deps.publish(entry.message);
        } catch {
          /* Coordination is best effort. */
        }
      }
      entry.count++;
      let finished = false;
      return (success: boolean) => {
        if (finished) return;
        finished = true;
        entry!.failed ||= !success;
        if (--entry!.count) return;
        sent.delete(id);
        try {
          deps.publish({
            ...entry!.message,
            phase: entry!.failed ? "failed" : "completed",
          });
        } catch {
          /* No auth side effects. */
        }
      };
    },
    revoked(observedGuest: string | null) {
      // An old guest watch must never sign out a replacement WorkOS identity.
      if (observedGuest && observedGuest !== guestId) return true;
      if (!guestId) return false;
      if (store.getState().status !== "idle") return true;
      receive({
        guestId,
        attempt: authCorrelationId(),
        startedAt: Date.now(),
        phase: "completed",
      });
      return true;
    },
    retry: () => reload(false),
    dispose: reset,
  };
}

let channel: BroadcastChannel | undefined;
export const guestTabRecovery = createGuestTabRecovery({
  beforeTransition: (message) =>
    projectTransitionRecovery.arm(
      currentProjectTransitionPath(),
      message.attempt,
    ),
  publish(message) {
    try {
      channel?.postMessage(message);
    } catch {
      /* Storage fallback below. */
    }
    try {
      localStorage.setItem(CHANNEL, JSON.stringify(message));
    } catch {
      /* Storage can be blocked. */
    }
  },
  reload: () => {
    const guest = guestTabRecovery.getGuest();
    queueMicrotask(() => {
      if (guestTabRecovery.getGuest() === guest) window.location.reload();
    });
  },
  allowAutomaticReload() {
    try {
      const previous = Number(sessionStorage.getItem(RELOAD_KEY));
      if (previous && Date.now() - previous < MAX_AGE_MS) return false;
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      return true;
    } catch {
      return false;
    } // No persistent loop guard: offer an explicit retry.
  },
});

export function listenForGuestTransitions(): () => void {
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e) =>
      flushSync(() => guestTabRecovery.receive(e.data));
  } catch {
    /* Storage-only browsers. */
  }
  const read = readGuestTransition;
  const storage = (e: StorageEvent) => {
    if (e.key === CHANNEL) read();
  };
  window.addEventListener("storage", storage);
  window.addEventListener("pageshow", read);
  window.addEventListener("focus", read);
  document.addEventListener("visibilitychange", read);
  read();
  return () => {
    channel?.close();
    channel = undefined;
    window.removeEventListener("storage", storage);
    window.removeEventListener("pageshow", read);
    window.removeEventListener("focus", read);
    document.removeEventListener("visibilitychange", read);
  };
}

/** Query failures can be read during render; defer the synchronous unmount. */
export function recoverRevokedGuest(observedGuest: string | null): boolean {
  const currentGuest = guestTabRecovery.getGuest();
  if (observedGuest && observedGuest !== currentGuest) return true;
  if (!currentGuest) return false;
  queueMicrotask(() => {
    if (guestTabRecovery.getGuest() === currentGuest) {
      flushSync(() => guestTabRecovery.revoked(currentGuest));
    }
  });
  return true;
}

/** Catch transitions missed while this tab was asleep or still bootstrapping. */
export function readGuestTransition(): void {
  queueMicrotask(() => {
    try {
      flushSync(() =>
        guestTabRecovery.receive(
          JSON.parse(localStorage.getItem(CHANNEL) ?? "null"),
        ),
      );
    } catch {
      /* Storage is optional. */
    }
  });
}
