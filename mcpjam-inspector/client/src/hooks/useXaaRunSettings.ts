import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  isNegativeTestMode,
  type NegativeTestMode,
} from "@/shared/xaa.js";

// Run-level settings that are global across every XAA target: the simulated
// identity (sub/email) and the negative-test Mode. Target-specific config
// (server URL, client id, secret, scopes) lives on the server, not here.
const RUN_SETTINGS_KEY = "mcpjam-xaa-run-settings/v1";
// The legacy single-config debugger profile we migrate identity + mode from
// once, on first load (mirrors profile.ts XAA_PROFILE_STORAGE_KEY).
const LEGACY_PROFILE_KEY = "mcpjam-xaa-debugger-profile/v1";

/** Which issuer mints the mock ID token + ID-JAG on a local run. "hosted"
 * routes the mint through app.mcpjam.com so a cloud authorization server can
 * discover/validate the issuer — no tunnel needed. Meaningless on hosted
 * builds (hosted IS the hosted issuer). */
export type XaaIssuerMode = "local" | "hosted";

export interface XaaRunSettings {
  userId: string;
  email: string;
  negativeTestMode: NegativeTestMode;
  issuerMode: XaaIssuerMode;
  /** Selected test identity ("Run as" person) per project — keyed by project
   * id so switching projects never clears another project's selection. Values
   * are testIdentities row ids; a stale id (person deleted) resolves to no
   * selection at read time. */
  selectedPersonIdByProject: Record<string, string>;
}

export const DEFAULT_XAA_RUN_SETTINGS: XaaRunSettings = {
  userId: "user-12345",
  email: "demo.user@example.com",
  negativeTestMode: DEFAULT_NEGATIVE_TEST_MODE,
  issuerMode: "local",
  selectedPersonIdByProject: {},
};

function sanitizeMode(value: unknown): NegativeTestMode {
  return isNegativeTestMode(value) ? value : DEFAULT_NEGATIVE_TEST_MODE;
}

function sanitizeIssuerMode(value: unknown): XaaIssuerMode {
  return value === "hosted" ? "hosted" : "local";
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : fallback;
}

/** Keep only string→non-empty-string entries; anything else resets to {}. */
function sanitizePersonMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      key.trim().length > 0 &&
      typeof entry === "string" &&
      entry.trim().length > 0
    ) {
      map[key] = entry;
    }
  }
  return map;
}

// One-time read, consumed only inside the lazy useState initializer below —
// never in the render body. When the new key is absent, identity + mode are
// migrated from the legacy debugger profile once; once the new key exists the
// legacy values are ignored, so the migration never re-seeds.
function loadInitialRunSettings(): XaaRunSettings {
  try {
    const raw = localStorage.getItem(RUN_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<XaaRunSettings>;
      return {
        userId: readString(parsed.userId, DEFAULT_XAA_RUN_SETTINGS.userId),
        email: readString(parsed.email, DEFAULT_XAA_RUN_SETTINGS.email),
        negativeTestMode: sanitizeMode(parsed.negativeTestMode),
        issuerMode: sanitizeIssuerMode(parsed.issuerMode),
        selectedPersonIdByProject: sanitizePersonMap(
          parsed.selectedPersonIdByProject,
        ),
      };
    }

    const legacyRaw = localStorage.getItem(LEGACY_PROFILE_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as Record<string, unknown>;
      const migrated: XaaRunSettings = {
        userId: readString(legacy.userId, DEFAULT_XAA_RUN_SETTINGS.userId),
        email: readString(legacy.email, DEFAULT_XAA_RUN_SETTINGS.email),
        negativeTestMode: sanitizeMode(legacy.negativeTestMode),
        issuerMode: "local",
        selectedPersonIdByProject: {},
      };
      try {
        localStorage.setItem(RUN_SETTINGS_KEY, JSON.stringify(migrated));
      } catch {
        // Ignore storage failures; the in-memory value still applies.
      }
      return migrated;
    }
  } catch {
    // Ignore parse/storage failures and fall back to defaults.
  }
  return { ...DEFAULT_XAA_RUN_SETTINGS };
}

export function isDefaultIdentity(settings: {
  userId: string;
  email: string;
}): boolean {
  return (
    settings.userId === DEFAULT_XAA_RUN_SETTINGS.userId &&
    settings.email === DEFAULT_XAA_RUN_SETTINGS.email
  );
}

export function useXaaRunSettings() {
  const [settings, setSettings] =
    useState<XaaRunSettings>(loadInitialRunSettings);

  // Persist on change in an effect rather than inside the state updater, so a
  // StrictMode double-invoked updater never double-writes.
  useEffect(() => {
    try {
      localStorage.setItem(RUN_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage failures.
    }
  }, [settings]);

  const setNegativeTestMode = useCallback((mode: NegativeTestMode) => {
    setSettings((current) => ({
      ...current,
      negativeTestMode: sanitizeMode(mode),
    }));
  }, []);

  const setIdentity = useCallback(
    (patch: { userId?: string; email?: string }) => {
      setSettings((current) => ({
        ...current,
        ...(patch.userId !== undefined ? { userId: patch.userId } : {}),
        ...(patch.email !== undefined ? { email: patch.email } : {}),
      }));
    },
    [],
  );

  const setIssuerMode = useCallback((mode: XaaIssuerMode) => {
    setSettings((current) => ({
      ...current,
      issuerMode: sanitizeIssuerMode(mode),
    }));
  }, []);

  const setSelectedPersonId = useCallback(
    (projectId: string, personId: string | null) => {
      const key = projectId.trim();
      if (!key) return;
      setSettings((current) => {
        const map = { ...current.selectedPersonIdByProject };
        if (personId && personId.trim().length > 0) {
          map[key] = personId;
        } else {
          delete map[key];
        }
        return { ...current, selectedPersonIdByProject: map };
      });
    },
    [],
  );

  return useMemo(
    () => ({
      userId: settings.userId,
      email: settings.email,
      negativeTestMode: settings.negativeTestMode,
      issuerMode: settings.issuerMode,
      selectedPersonIdByProject: settings.selectedPersonIdByProject,
      isDefaultIdentity: isDefaultIdentity(settings),
      setNegativeTestMode,
      setIdentity,
      setIssuerMode,
      setSelectedPersonId,
    }),
    [
      settings,
      setNegativeTestMode,
      setIdentity,
      setIssuerMode,
      setSelectedPersonId,
    ],
  );
}
