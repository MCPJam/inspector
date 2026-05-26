/**
 * classifyDiagnoses
 *
 * Given the live `widgetDebugInfo.csp` data (effective allowlists, the
 * widget's declared CSP, and observed violations), produce the
 * `Diagnosis[]` the workbench renders.
 *
 * Three classes today; `cors`/`network`/`sandbox` are reserved for when
 * additional evidence sources land (see types.ts).
 */

import type { CspViolation } from "@/stores/widget-debug-store";
import type {
  ClassifierInput,
  CspField,
  Diagnosis,
  DiagnosisClass,
  EvidenceEntry,
} from "./types";
import { extractOrigin, originAllowedByAny } from "./match-source";

/**
 * Map a browser directive (e.g. "script-src", "img-src") to its
 * corresponding `_meta.ui.csp` field. Unsupported directives return
 * `null`; those still surface as `csp` cards but without an auto-patch.
 */
export function directiveToField(directive: string): CspField | null {
  // Strip trailing `-elem` / `-attr` variants the browser may report.
  const base = directive
    .toLowerCase()
    .replace(/-elem$/, "")
    .replace(/-attr$/, "");

  switch (base) {
    case "connect-src":
      return "connectDomains";
    case "script-src":
    case "style-src":
    case "img-src":
    case "font-src":
    case "media-src":
    case "default-src":
      return "resourceDomains";
    case "frame-src":
    case "child-src":
      return "frameDomains";
    case "base-uri":
      return "baseUriDomains";
    default:
      // worker-src, manifest-src, form-action, frame-ancestors, etc. —
      // not expressible in MCP-Apps `_meta.ui.csp`. Render the diagnosis
      // anyway, but with patch=null.
      return null;
  }
}

/** Read a field off the widget-declared CSP, tolerating both snake_case
 *  (OpenAI Apps SDK shape) and camelCase (MCP Apps spec shape). */
function readDeclared(
  declared: ClassifierInput["widgetDeclared"] | undefined,
  field: CspField,
): string[] | undefined {
  if (!declared) return undefined;
  switch (field) {
    case "connectDomains":
      return declared.connectDomains ?? declared.connect_domains;
    case "resourceDomains":
      return declared.resourceDomains ?? declared.resource_domains;
    case "frameDomains":
      return declared.frameDomains;
    case "baseUriDomains":
      return declared.baseUriDomains;
  }
}

function readEffective(
  effective: ClassifierInput["effective"],
  field: CspField,
): string[] | undefined {
  switch (field) {
    case "connectDomains":
      return effective.connectDomains;
    case "resourceDomains":
      return effective.resourceDomains;
    case "frameDomains":
      return effective.frameDomains;
    case "baseUriDomains":
      return effective.baseUriDomains;
  }
}

function whyForClass(
  klass: DiagnosisClass,
  directive: string,
  field: CspField | null,
): string {
  switch (klass) {
    case "csp":
      return `${directive} does not allow this origin`;
    case "host-stripped":
      return `${directive} — host stripped this entry from effective CSP`;
    case "runtime-mismatch":
      return `Effective CSP allowed ${directive} for this origin; browser blocked anyway`;
    case "cors":
      return `CSP allowed the request; the remote refused`;
    case "network":
      return `Network failure`;
    case "sandbox":
      return `Sandbox / Permissions Policy blocked this`;
    default:
      return field
        ? `${directive} (${field}) blocked`
        : `${directive} blocked`;
  }
}

function reconstructBrowserMessage(v: CspViolation): string {
  // The renderer doesn't capture the full console string today — reconstruct
  // a faithful approximation from the directive + URI. Honest enough to
  // copy/paste while we wait for the real message to land in the store.
  return `Refused to load '${v.blockedUri}' because it violates the document's Content Security Policy (${v.effectiveDirective || v.directive}).`;
}

function extractRisks(
  klass: DiagnosisClass,
  field: CspField | null,
  origin: string,
  declaredEntry: string | undefined,
): string[] {
  const risks: string[] = [];
  if (field === "frameDomains") risks.push("nested iframe");
  if (origin.startsWith("http://")) risks.push("http:");
  if (declaredEntry?.includes("*")) risks.push("wildcard");
  if (
    klass === "host-stripped" &&
    /\bcdn\b|cdn\./i.test(origin) &&
    !risks.includes("wildcard")
  ) {
    risks.push("broad CDN");
  }
  return risks;
}

/** Find the matching declared entry (string from the declared list), so the
 *  risk extractor can decide if the developer's entry was a wildcard. */
function findDeclaredEntry(
  origin: string,
  declared: string[] | undefined,
): string | undefined {
  if (!declared) return undefined;
  return declared.find((e) => originAllowedByAny(origin, [e]));
}

export function classifyDiagnoses(input: ClassifierInput): Diagnosis[] {
  const out: Diagnosis[] = [];
  for (let i = 0; i < input.violations.length; i++) {
    const v = input.violations[i];
    const directive = v.effectiveDirective || v.directive;
    const field = directiveToField(directive);
    const origin = extractOrigin(v.blockedUri);

    // If we can't parse the origin (keyword token, malformed), still surface
    // the diagnosis but without a patch.
    if (!origin) {
      out.push({
        id: `${v.blockedUri}|${directive}|${i}`,
        class: "csp",
        url: v.blockedUri,
        directive,
        why: whyForClass("csp", directive, field),
        browserMessage: reconstructBrowserMessage(v),
        risks: [],
        primarySource: "securitypolicyviolation",
        evidence: violationEvidence(v),
        patch: null,
      });
      continue;
    }

    const declared = field ? readDeclared(input.widgetDeclared, field) : undefined;
    const effective = field ? readEffective(input.effective, field) : undefined;

    const inDeclared = originAllowedByAny(origin, declared);
    const inEffective = originAllowedByAny(origin, effective);

    let klass: DiagnosisClass;
    if (inEffective) {
      klass = "runtime-mismatch";
    } else if (inDeclared) {
      klass = "host-stripped";
    } else {
      klass = "csp";
    }

    const declaredEntry = findDeclaredEntry(origin, declared);
    const risks = extractRisks(klass, field, origin, declaredEntry);

    const evidence: EvidenceEntry[] = [];
    if (klass === "host-stripped" || klass === "runtime-mismatch") {
      evidence.push({
        kind: "host-effective-csp",
        note:
          klass === "host-stripped"
            ? `Origin declared by widget but absent from effective ${field}`
            : `Origin present in effective ${field}`,
        timestamp: v.timestamp,
      });
    }
    evidence.push(...violationEvidence(v));

    const patch =
      klass === "csp" && field
        ? { field, add: [origin] }
        : klass === "host-stripped" && field
          ? { field, add: [origin] }
          : null;

    const primarySource: EvidenceEntry["kind"] =
      klass === "host-stripped"
        ? "host-effective-csp"
        : klass === "runtime-mismatch"
          ? "inferred"
          : "securitypolicyviolation";

    out.push({
      id: `${v.blockedUri}|${directive}|${i}`,
      class: klass,
      url: v.blockedUri,
      directive,
      why: whyForClass(klass, directive, field),
      browserMessage: reconstructBrowserMessage(v),
      risks,
      primarySource,
      evidence,
      patch,
    });
  }
  return out;
}

function violationEvidence(v: CspViolation): EvidenceEntry[] {
  return [
    {
      kind: "securitypolicyviolation",
      directive: v.effectiveDirective || v.directive,
      blockedUri: v.blockedUri,
      timestamp: v.timestamp,
      ...(v.sourceFile ? { documentUri: v.sourceFile } : {}),
    },
  ];
}

/** Helpers used by the FindingsTab summary strip. Counters are exclusive
 *  on `class`. */
export function summarize(diagnoses: Diagnosis[]) {
  let csp = 0,
    cors = 0,
    hostStripped = 0,
    runtimeMismatch = 0,
    network = 0,
    sandbox = 0;
  let fixes = 0,
    declarations = 0;

  for (const d of diagnoses) {
    switch (d.class) {
      case "csp":
        csp++;
        if (d.patch) fixes++;
        break;
      case "cors":
        cors++;
        break;
      case "host-stripped":
        hostStripped++;
        if (d.patch) declarations++;
        break;
      case "runtime-mismatch":
        runtimeMismatch++;
        break;
      case "network":
        network++;
        break;
      case "sandbox":
        sandbox++;
        break;
    }
  }

  return {
    total: diagnoses.length,
    csp,
    cors,
    hostStripped,
    runtimeMismatch,
    network,
    sandbox,
    fixes,
    declarations,
  };
}
