/**
 * Atomic XAA test-identity resolution and save semantics.
 *
 * An identity is a PAIR (subject + email), never two independent fallback
 * chains — mixing one source's subject with another source's email would
 * assert an identity nobody configured. Every consumer (debugger runs, the
 * Connect-page save paths, placeholders) resolves whole pairs through the
 * helpers here.
 */

export interface XaaIdentityPair {
  subject: string;
  email: string;
}

/** The documented MCPJam demo identity — the terminal fallback for Connect
 * mints when neither a server override nor a project default exists. Also
 * shown as the override-field placeholder when the project has no default. */
export const XAA_DEMO_IDENTITY: XaaIdentityPair = {
  subject: "user-12345",
  email: "demo.user@example.com",
};

/** Actionable error for a partial (one-field) per-server override. Shared by
 * the debugger run gate and the Connect/save validation so both surfaces show
 * the same fix. */
export const XAA_PARTIAL_OVERRIDE_ERROR =
  "Complete or clear the server identity override";

export type XaaTestIdentitySource =
  | "person"
  | "server_override"
  | "project_default"
  | "run_fallback";

export type XaaTestIdentityResolution =
  | { ok: true; identity: XaaIdentityPair; source: XaaTestIdentitySource }
  | { ok: false; error: string };

function isNonEmpty(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when both members of a candidate pair are present and non-blank. */
export function isCompleteIdentityPair(
  pair: { subject?: string | null; email?: string | null } | null | undefined,
): pair is XaaIdentityPair {
  return isNonEmpty(pair?.subject) && isNonEmpty(pair?.email);
}

/**
 * Resolve the effective debugger test identity with atomic precedence:
 *
 *   selected Person > complete server override > project default > run fallback
 *
 * - A registration target has no server override — pass `serverOverride:
 *   null` and the chain becomes person > project default > run fallback.
 * - A PARTIAL legacy server override (exactly one member set) is a
 *   configuration error, not a mixable half-identity: the run must block
 *   with the same actionable error Connect surfaces.
 * - A partial project default never mixes either; the backend validates the
 *   stored pair as atomic, so anything incomplete is treated as absent.
 */
export function resolveXaaTestIdentity({
  selectedPerson,
  serverOverride,
  projectDefault,
  runFallback,
}: {
  /** Explicit "Run as" person — always wins, both fields together. */
  selectedPerson: XaaIdentityPair | null | undefined;
  /** Raw per-server xaaSubject/xaaEmail; null/undefined for targets that
   * have none (registration runs). */
  serverOverride:
    | { subject?: string | null; email?: string | null }
    | null
    | undefined;
  /** The project's admin-controlled `xaaTestDefaults.defaultIdentity`. */
  projectDefault: XaaIdentityPair | null | undefined;
  /** The debugger's run-settings identity (terminal fallback). */
  runFallback: XaaIdentityPair;
}): XaaTestIdentityResolution {
  // A person is an atomic identity too: require BOTH members so a roster row
  // with a blank email can never emit a subject-only identity. An incomplete
  // person falls through to the next source (rows are created with a required
  // email, so this is defensive).
  if (isCompleteIdentityPair(selectedPerson)) {
    return {
      ok: true,
      identity: { subject: selectedPerson.subject, email: selectedPerson.email },
      source: "person",
    };
  }

  const overrideSubjectSet = isNonEmpty(serverOverride?.subject);
  const overrideEmailSet = isNonEmpty(serverOverride?.email);
  if (overrideSubjectSet !== overrideEmailSet) {
    return { ok: false, error: XAA_PARTIAL_OVERRIDE_ERROR };
  }
  if (overrideSubjectSet && overrideEmailSet) {
    return {
      ok: true,
      identity: {
        subject: serverOverride!.subject as string,
        email: serverOverride!.email as string,
      },
      source: "server_override",
    };
  }

  if (isCompleteIdentityPair(projectDefault)) {
    return {
      ok: true,
      identity: {
        subject: projectDefault.subject,
        email: projectDefault.email,
      },
      source: "project_default",
    };
  }

  return { ok: true, identity: runFallback, source: "run_fallback" };
}

/**
 * Shared save semantics for the per-server identity pair + authServerMode —
 * the single implementation behind use-server-state's three payload builders
 * (connect, save-without-connect, update). The form emits the pair
 * atomically:
 *
 * - both members `undefined` (untouched form) → preserve the stored values;
 * - both non-empty (edited complete pair) → write the trimmed pair;
 * - both `""` (explicit clear) → write `""` for both, which the Convex sync
 *   forwards so the backend normalizes the pair away. Locally an empty
 *   string reads as "no override" everywhere (all consumers trim-check).
 *
 * A one-sided patch never mixes: the missing member is completed from the
 * stored row so the emitted pair stays atomic (mirroring the backend's
 * merge-then-validate). Non-XAA saves preserve the stored values untouched,
 * and `authServerMode` keeps its existing `?? "mcpjam"` default.
 */
export function resolveXaaIdentitySaveFields({
  useXaa,
  formAuthServerMode,
  formSubject,
  formEmail,
  existing,
}: {
  useXaa: boolean;
  formAuthServerMode?: "mcpjam" | "own";
  formSubject?: string;
  formEmail?: string;
  existing?: {
    authServerMode?: "mcpjam" | "own";
    xaaSubject?: string;
    xaaEmail?: string;
  };
}): {
  authServerMode?: "mcpjam" | "own";
  xaaSubject?: string;
  xaaEmail?: string;
} {
  if (!useXaa) {
    return {
      authServerMode: existing?.authServerMode,
      xaaSubject: existing?.xaaSubject,
      xaaEmail: existing?.xaaEmail,
    };
  }

  const authServerMode = formAuthServerMode ?? "mcpjam";
  if (formSubject === undefined && formEmail === undefined) {
    // Untouched pair → preserve what's stored.
    return {
      authServerMode,
      xaaSubject: existing?.xaaSubject,
      xaaEmail: existing?.xaaEmail,
    };
  }

  const resolvedSubject = (formSubject ?? existing?.xaaSubject ?? "").trim();
  const resolvedEmail = (formEmail ?? existing?.xaaEmail ?? "").trim();
  // Atomic: a one-sided result is never a valid persisted override. The form
  // blocks partial saves, but guard here too so a caller that bypasses that
  // validation (e.g. local, non-Convex persistence with no backend
  // normalization) can't store a half-identity — clear both instead.
  if ((resolvedSubject === "") !== (resolvedEmail === "")) {
    return { authServerMode, xaaSubject: "", xaaEmail: "" };
  }
  return {
    authServerMode,
    xaaSubject: resolvedSubject,
    xaaEmail: resolvedEmail,
  };
}
