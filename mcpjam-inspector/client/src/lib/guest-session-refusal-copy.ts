import type { GuestSessionRefusalReason } from "./guest-session";

export interface GuestSessionRefusalCopy {
  /** One line for the top-of-page banner. */
  banner: string;
  /** Short heading for the onboarding notice. */
  title: string;
  /** What happened and what to do next, for the onboarding notice. */
  detail: string;
  /** Why sign-in is needed, under the onboarding "Sign in to continue". */
  summary: string;
}

const COPY: Record<GuestSessionRefusalReason, GuestSessionRefusalCopy> = {
  rate_limited: {
    banner: "Too many guest sessions from your network today. Sign in to continue.",
    title: "Guest session limit reached",
    detail:
      "Too many guest sessions were created from this network today. Sign in to continue setting up your server.",
    summary:
      "MCPJam couldn't create another guest session from this network today. Sign in to continue.",
  },
  guest_access_disabled: {
    banner: "Guest access is off on this deployment. Sign in to continue.",
    title: "Guest access is off",
    detail:
      "This deployment doesn't allow guest sessions. Sign in to continue setting up your server.",
    summary: "This deployment doesn't allow guest sessions. Sign in to continue.",
  },
};

export function guestSessionRefusalCopy(
  reason: GuestSessionRefusalReason,
): GuestSessionRefusalCopy {
  return COPY[reason];
}
