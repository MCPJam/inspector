import type { GuardLocation } from "@/hooks/use-unsaved-changes-guard";
import { stripProjectFromPath } from "@/lib/project-route";

const SETTINGS_PATH =
  /^\/evaluate\/suite\/([^/]+)\/settings(?:\/(?:cases|evaluators))?\/?$/;

function settingsSuiteId(pathname: string): string | null {
  return SETTINGS_PATH.exec(stripProjectFromPath(pathname))?.[1] ?? null;
}

/**
 * True when both locations are tabs of the same suite's settings page, so
 * moving between them keeps the draft on screen and needs no prompt.
 */
export function isSameSuiteSettingsPage(
  current: GuardLocation,
  next: GuardLocation,
): boolean {
  const suiteId = settingsSuiteId(current.pathname);
  return suiteId !== null && suiteId === settingsSuiteId(next.pathname);
}
