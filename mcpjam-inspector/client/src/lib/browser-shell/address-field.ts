/**
 * The address field's state, as a value rather than as three `useState`s.
 *
 * It looks like the simplest control in the shell and it is the one with the
 * most ways to be subtly wrong, because it has two sources of truth that
 * disagree constantly. The BROWSER says where the page is, and it says so
 * several times a second: a redirect chain settles, an SPA rewrites the URL
 * with `pushState`, a heartbeat reconciles, the agent navigates. The PERSON
 * says where they want to go, one keystroke at a time. A field that let the
 * first overwrite the second deletes what somebody is typing — and it does it
 * mid-word, on a page that happens to be busy, which is the most infuriating
 * possible version of the bug.
 *
 * So the rule is: while the field is being EDITED, the browser's updates are
 * recorded and not shown. The draft wins until the person commits it (Enter)
 * or abandons it (Escape, or blurring), and only then does the field snap back
 * to whatever the browser has been saying in the meantime.
 *
 * The at-rest / focused split is a separate axis and a deliberate one. At rest
 * the field shows the HOST, because it is a wide element on a screen somebody
 * else can be standing next to and a path carries reset tokens, share links
 * and account ids. Focusing reveals the whole URL — an act by the person who
 * owns the screen, not something that happens because a page loaded.
 *
 * Pure, so every one of those interleavings is a test rather than a thing to
 * try by hand.
 */

import {
  addressAtRest,
  normalizePaneUrl,
} from "../../../../shared/browser-pane-command";

export interface AddressFieldState {
  /** Where the browser says the page is. Updated freely, shown conditionally. */
  url: string;
  /** What the person has typed, or null when they are not editing. */
  draft: string | null;
  focused: boolean;
}

export const EMPTY_ADDRESS_FIELD: AddressFieldState = {
  url: "",
  draft: null,
  focused: false,
};

export type AddressFieldEvent =
  /** The browser navigated, or a heartbeat reconciled the URL. */
  | { type: "url"; url: string }
  | { type: "focus" }
  | { type: "blur" }
  | { type: "edit"; value: string }
  /** Enter. Carries the URL to navigate to, when the draft was one. */
  | { type: "commit" }
  /** Escape. */
  | { type: "cancel" };

export function reduceAddressField(
  state: AddressFieldState,
  event: AddressFieldEvent,
): AddressFieldState {
  switch (event.type) {
    case "url": {
      if (state.url === event.url) return state;
      // RECORDED, not shown, while a draft exists. This is the whole point of
      // the module: an agent navigating while somebody types an address must
      // not take the address out from under them.
      return { ...state, url: event.url };
    }
    case "focus": {
      if (state.focused) return state;
      // Focusing does NOT start a draft. Reading the full URL is a thing
      // people do to check where the agent went, and a focus that immediately
      // became an edit would make Escape necessary to leave the field alone.
      return { ...state, focused: true };
    }
    case "blur": {
      if (!state.focused && state.draft === null) return state;
      // Blurring abandons the draft, exactly as Escape does. A half-typed
      // address left in a field that has stopped being the thing you are
      // looking at is a lie about where the browser is — and the URL it
      // reverts to is the one the browser has been reporting all along.
      return { ...state, focused: false, draft: null };
    }
    case "edit": {
      if (state.draft === event.value) return state;
      return { ...state, draft: event.value };
    }
    case "cancel": {
      if (state.draft === null) return state;
      return { ...state, draft: null };
    }
    case "commit": {
      // The draft is cleared whether or not it was a URL. A committed address
      // that turns out to be unnavigable is reported by the pane's notice, and
      // leaving the text in the field would leave the field disagreeing with
      // the page for as long as somebody left it alone.
      if (state.draft === null) return state;
      return { ...state, draft: null };
    }
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return state;
    }
  }
}

/** What the input element should display right now. */
export function addressFieldValue(state: AddressFieldState): string {
  if (state.draft !== null) return state.draft;
  // The WHOLE url while focused, the host at rest. @see the module docstring
  return state.focused ? state.url : addressAtRest(state.url);
}

/**
 * Where a commit should navigate, or null when the draft is not a place.
 *
 * Separate from the reducer because it is the one part with an outward effect:
 * the reducer says what the field looks like, this says what to do about it.
 */
export function addressFieldTarget(state: AddressFieldState): string | null {
  if (state.draft === null) return null;
  return normalizePaneUrl(state.draft);
}

/**
 * Is the person editing right now?
 *
 * Used to suppress the shell's own keyboard handling — a `/` that focuses the
 * address field is a nice shortcut and a disaster while somebody is typing a
 * path into it.
 */
export function isEditing(state: AddressFieldState): boolean {
  return state.draft !== null;
}
