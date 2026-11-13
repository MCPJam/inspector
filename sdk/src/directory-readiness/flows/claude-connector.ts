/**
 * Claude's "Submit an MCP connector" form.
 *
 * The portal's wording, its page layout and review page, and where each
 * engine check's result belongs are data in `claude-connector.json`, copied
 * from captures of the live portal (`version` names the capture). The test
 * fixture `claude-connector-portal-labels.json` holds the same wording apart
 * from it, for a person to check against the captures. The rules each field
 * enforces are typed here, and the compiler holds both files to one set of
 * field keys.
 *
 * Pure data. Safe from the browser entry.
 */

import { CLAUDE_SUBMISSION_LIMITS as LIMITS } from "../../claude-readiness/profile.js";
import data from "./claude-connector.json" with { type: "json" };
import {
  placementsFrom,
  stepFields,
  type DirectoryFieldRules as FieldRules,
  type DirectoryFieldWords,
} from "./data.js";
import type { DirectoryFlow, DirectoryStepLayout } from "./types.js";

type FieldKey = keyof typeof data.fields;
interface StepWords {
  title: string;
  intro: string;
  layout?: DirectoryStepLayout;
}

const WORDS: Record<FieldKey, DirectoryFieldWords> = data.fields;
const STEPS: Record<string, StepWords> = data.steps;

const declared = { declaration: true } as const;
const https = { format: "https-url" } as const;

function req(control: FieldRules["control"], rest: Partial<FieldRules> = {}) {
  return { control, required: true, ...rest };
}

function opt(control: FieldRules["control"], rest: Partial<FieldRules> = {}) {
  return { control, ...rest };
}

/** Each field's rules, in form order. A field's step is its key's prefix. */
const RULES: Record<FieldKey, FieldRules> = {
  "connection.serverUrl": req("server", { format: "url" }),
  "connection.differentUrls": opt("checkbox"),
  "listing.name": req("text"),
  "listing.slug": req("text", { format: "slug" }),
  "listing.oneLiner": req("text", { maxLength: LIMITS.oneLinerMaxLength }),
  "listing.description": req("textarea", {
    maxLength: LIMITS.descriptionMaxLength,
  }),
  // The portal's category list was never captured.
  "listing.categories": req("multi-select", {
    freeEntry: true,
    minItems: LIMITS.categoriesMin,
    maxItems: LIMITS.categoriesMax,
  }),
  // Asked for only on the review page, which takes the company name and an
  // https website in its place.
  "listing.authorName": req("text", {
    requiredOn: "review",
    satisfiedBy: [
      { key: "company.name" },
      { key: "company.website", format: "https-url" },
    ],
  }),
  "listing.authorUrl": opt("text", https),
  "listing.iconUrl": opt("text", https),
  "listing.documentationUrl": req("text", https),
  "listing.enterpriseAuthDocsUrl": opt("text", https),
  "listing.support": req("text", { format: "url-or-email" }),
  "listing.privacyPolicyUrl": req("text", https),
  "useCases.pairs": req("pairs", {
    pairs: {
      columns: ["Use case", "Example prompt"],
      keys: ["useCase", "examplePrompt"],
      placeholders: [
        ["Look up a product", "What sizes are in stock at the Portland store?"],
        ["Compare prices", "Which fall items are marked down more than 30%?"],
        [
          "Draft a product listing",
          "Create a draft listing for the canvas tote.",
        ],
      ],
      maxRows: LIMITS.useCasesMax,
    },
  }),
  "useCases.prerequisites": req("textarea"),
  "useCases.access": req("radio", { ...declared, default: "read-only" }),
  "company.name": req("text", { prefill: "organization-name" }),
  "company.website": req("text", { format: "url" }),
  "company.contactName": req("text", { prefill: "account-name" }),
  "company.contactEmail": req("text", {
    format: "email",
    prefill: "account-email",
  }),
  "company.role": opt("text"),
  "company.anthropicContact": opt("text"),
  "authentication.requirement": req("radio", { default: "always" }),
  "authentication.oauthClient": req("radio", { default: "dcr" }),
  "dataHandling.apiOwnership": req("radio-cards", {
    ...declared,
    default: "own",
  }),
  "dataHandling.healthData": req("radio", { ...declared, default: "no" }),
  "dataHandling.sponsored": req("radio", declared),
  "testLaunch.instructions": opt("textarea"),
  "testLaunch.selfTested": opt("checkbox", declared),
  "compliance.acknowledgments": req("checkbox-group", {
    ...declared,
    minItems: data.fields["compliance.acknowledgments"].options.length,
  }),
  "compliance.additionalNotes": opt("textarea"),
};

export const CLAUDE_CONNECTOR_FLOW: DirectoryFlow = {
  id: "claude-connector",
  directory: "claude",
  title: data.title,
  version: "2026-11-13",
  source: {
    label: "Claude directory portal: Submit an MCP connector",
    url: "https://claude.ai/directory/manage",
    capturedAt: "2026-11-13",
  },
  submissionUrl: "https://claude.ai/directory/manage",
  steps: Object.keys(STEPS).map((id) => ({
    id,
    ...STEPS[id],
    fields: stepFields(id, RULES, WORDS),
  })),
  placements: placementsFrom("claude-connector.json", data.placements),
  laneSteps: data.laneSteps,
};
