/**
 * CSP Workbench — DTOs
 *
 * The workbench is a pure UI surface fed from `widget-debug-store`. These
 * types describe the *derived* diagnosis records the UI renders, not the
 * raw violations/policy already in the store.
 */

import type { CspViolation } from "@/stores/widget-debug-store";

/**
 * Diagnosis class. Exclusive — every diagnosis belongs to exactly one.
 * Multi-label semantics go in `risks[]`.
 *
 * `csp`               – violation against an origin the server didn't declare.
 *                       The patch (adding the origin to `_meta.ui.csp.*`)
 *                       fixes the current run.
 * `host-stripped`     – violation against an origin the server *did* declare
 *                       but the host removed before the browser saw it.
 *                       The "patch" is really a *declaration of intent for
 *                       portability* — it will not fix this host today.
 * `runtime-mismatch`  – violation against an origin that the *effective* CSP
 *                       (post-host) allows. Cause unknown from policy alone —
 *                       could be runtime restriction, browser/extension layer,
 *                       or evidence-collection lag. No CSP patch will help.
 * `cors`              – CSP allowed it, network refused (Access-Control-*).
 *                       Server-side fix only. **Not classified yet** — we
 *                       have no signal source. Reserved for future use.
 * `network`           – DNS/TLS/404. Not CSP. Reserved for future use.
 * `sandbox`           – Permissions Policy / sandbox attribute issue.
 *                       Reserved for future use.
 */
export type DiagnosisClass =
  | "csp"
  | "host-stripped"
  | "runtime-mismatch"
  | "cors"
  | "network"
  | "sandbox";

/**
 * The `_meta.ui.csp` field a diagnosis maps to (if any). `null` when the
 * directive can't be expressed in MCP-Apps CSP metadata (worker-src,
 * manifest-src, form-action, frame-ancestors, …) — surfaces the directive
 * in the card body but offers no auto-patch.
 */
export type CspField =
  | "connectDomains"
  | "resourceDomains"
  | "frameDomains"
  | "baseUriDomains";

export interface EvidenceEntry {
  /** The signal that produced this evidence row. */
  kind:
    | "securitypolicyviolation"
    | "host-effective-csp"
    | "console"
    | "network"
    | "inferred";
  /** Free-text description, only when not derivable from the other fields. */
  note?: string;
  /** Mirrored from the underlying violation when applicable. */
  directive?: string;
  blockedUri?: string;
  documentUri?: string;
  /** Millis since the workbench's epoch start (or absolute UNIX millis). */
  timestamp: number;
}

export interface DiagnosisPatch {
  field: CspField;
  /** Domains to add to that field. Always a single-entry array today, but
   *  modeled as a list so future grouped patches don't need a schema change. */
  add: string[];
}

export interface Diagnosis {
  /** Stable per-run id — `${blockedUri}|${directive}|${index}`. */
  id: string;
  class: DiagnosisClass;
  /** Verbatim request the browser tried to make. */
  url: string;
  /** The browser's `effectiveDirective` (e.g. "connect-src"). */
  directive: string;
  /** Plain-English summary of the failure (one line). */
  why: string;
  /** Verbatim browser message, as close as we can reconstruct. */
  browserMessage: string;
  /** Secondary annotations. Multi-label. */
  risks: string[];
  /** Single string for at-a-glance triage. Full chain lives in `evidence[]`. */
  primarySource: EvidenceEntry["kind"];
  evidence: EvidenceEntry[];
  /** `null` for diagnoses where a CSP patch would not fix the current run. */
  patch: DiagnosisPatch | null;
}

/**
 * Inputs the classifier reads. Mirrors the shape `tool-part.tsx` already
 * passes to the existing debug panel via `sandboxInfo`.
 */
export interface ClassifierInput {
  /** Effective CSP after the host resolved/intersected the widget's request. */
  effective: {
    connectDomains: string[];
    resourceDomains: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  /** What the server originally declared in `_meta.ui.csp`. */
  widgetDeclared?: {
    connect_domains?: string[];
    resource_domains?: string[];
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  } | null;
  /** Observed violations from the live store. */
  violations: CspViolation[];
}
