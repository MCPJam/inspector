/**
 * Leads a profile export's error once Chromium has closed for the archive:
 * no browser is left, so the sign-in can't be saved again from it. Shared by
 * the daemon, which throws it, and the save route, which reads it.
 */
export const PROFILE_EXPORT_BROWSER_CLOSED = "profile_export_browser_closed";
