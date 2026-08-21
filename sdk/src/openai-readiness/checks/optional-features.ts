/**
 * Capability badges.
 *
 * A BADGE IS NOT A GRADE, and this file exists to keep that true. Absence is
 * never a defect: a plugin with no UI template, no imported skills and no
 * checkout flow is a perfectly good plugin, and the moment a badge can lower a
 * verdict it has stopped being a badge and become a requirement nobody wrote
 * down.
 *
 * The mechanism is structural rather than a promise. Everything here is
 * `experimental-feature`, which `isDispositiveDirectoryFinding` excludes by
 * construction, and it lives in `optional-features`, which no stage rolls up.
 * Two independent guards, because this is exactly the kind of rule that erodes.
 *
 * `state` distinguishes `supported` (observed working), `unsupported` (observed
 * absent) and `not-evaluated` (never looked) — collapsing the last two would
 * report a capability as missing when nobody checked.
 *
 * Pure data. No transport.
 */

import { openaiPolicySource } from "../manifest.js";
import type {
  OpenAICapabilityBadge,
  OpenAIReadinessFinding,
} from "../types.js";
import {
  informational,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

export interface OpenAIOptionalFeatureEvidence {
  /** Whether the server advertised the skills extension. */
  importedSkills?: boolean;
  /** How many UI resources the server serves. */
  uiResourceCount?: number;
  /** Whether any authorization server supports Client ID Metadata Documents. */
  clientIdMetadataDocuments?: boolean;
  /** Whether the plugin implements a checkout flow. */
  checkout?: boolean;
}

export interface OpenAIOptionalFeatureOutput {
  findings: OpenAIReadinessFinding[];
  badges: OpenAICapabilityBadge[];
}

interface BadgeSpec {
  id: string;
  title: string;
  section: string;
  page: Parameters<typeof openaiPolicySource>[0];
  read: (evidence: OpenAIOptionalFeatureEvidence) => boolean | undefined;
  detail: (state: OpenAICapabilityBadge["state"]) => string;
}

const BADGES: BadgeSpec[] = [
  {
    id: "openai.feature.imported-skills",
    title: "Skills imported from the MCP server",
    page: "build/skills",
    section: "§Importing from MCP",
    read: (evidence) => evidence.importedSkills,
    detail: (state) =>
      state === "supported"
        ? "The server advertises the skills extension."
        : "The server advertises no skills extension; skills can also be uploaded in the package.",
  },
  {
    id: "openai.feature.ui-templates",
    title: "Plugin UI templates",
    page: "build/chatgpt-ui",
    section: "§Adding UI",
    read: (evidence) =>
      evidence.uiResourceCount === undefined
        ? undefined
        : evidence.uiResourceCount > 0,
    detail: (state) =>
      state === "supported"
        ? "The server serves at least one UI resource."
        : "The server serves no UI resource; a text-only plugin is a supported shape.",
  },
  {
    id: "openai.feature.cimd",
    title: "Client ID Metadata Documents",
    page: "build/auth",
    section: "§Client registration",
    read: (evidence) => evidence.clientIdMetadataDocuments,
    detail: (state) =>
      state === "supported"
        ? "An authorization server supports Client ID Metadata Documents."
        : "No authorization server advertises Client ID Metadata Documents; dynamic registration also works.",
  },
  {
    id: "openai.feature.checkout",
    title: "In-conversation checkout",
    page: "build/monetization",
    section: "§Checkout",
    read: (evidence) => evidence.checkout,
    detail: (state) =>
      state === "supported"
        ? "The plugin implements a checkout flow."
        : "The plugin implements no checkout flow; external checkout is the recommended default.",
  },
];

export function runOpenAIOptionalFeatureChecks(
  evidence: OpenAIOptionalFeatureEvidence,
  stamp: OpenAICheckStamp,
): OpenAIOptionalFeatureOutput {
  const findings: OpenAIReadinessFinding[] = [];
  const badges: OpenAICapabilityBadge[] = [];

  for (const spec of BADGES) {
    const observed = spec.read(evidence);
    const state: OpenAICapabilityBadge["state"] =
      observed === undefined
        ? "not-evaluated"
        : observed
          ? "supported"
          : "unsupported";

    badges.push({
      id: spec.id,
      title: spec.title,
      state,
      detail:
        state === "not-evaluated"
          ? "This run did not look."
          : spec.detail(state),
      provenance: "wire",
    });

    const definition: OpenAICheckDefinition = {
      id: spec.id,
      title: spec.title,
      lane: "optional-features",
      // `experimental-feature` is what makes this structurally incapable of
      // failing a lane, whatever a future reader assumes about badges.
      class: "experimental-feature",
      source: openaiPolicySource(spec.page, spec.section),
      provenance: "wire",
      intrusiveness: "passive",
    };

    findings.push(
      informational(
        definition,
        stamp,
        { state },
        state === "not-evaluated"
          ? "This run did not look for this capability."
          : spec.detail(state),
      ),
    );
  }

  return { findings, badges };
}
