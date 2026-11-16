/**
 * ChatGPT's plugin submission, as the portal runs it: upload a ZIP, resolve
 * the checks on the plugin's "Metadata & Skills" and "MCPs" tabs, fill in
 * "Review information", attest and submit for review, then publish.
 *
 * Most of a listing lives in the package, and the portal shows it read only.
 * Those fields are `managedBy: "package"` with the path the package keeps
 * them at, so only an import sets them. The reviewer's password is the name of
 * a project secret: the answer never holds the password itself.
 *
 * Wording, layout and placements are data in `chatgpt-plugin.json`, copied
 * from OpenAI's submission docs and captures of the live portal (`version`
 * names the capture). The test fixture `chatgpt-plugin-portal-labels.json`
 * holds the same wording for a person to check. The rules are typed here.
 *
 * Pure data. Safe from the browser entry.
 */

import {
  OPENAI_FIELD_LIMITS,
  OPENAI_SUBMISSION_TEST_CASES as CASES,
} from "../../openai-readiness/profile.js";
import { DIRECTORY_REVIEWER_FIXTURE_PAIRS } from "../reviewer/evidence.js";
import data from "./chatgpt-plugin.json" with { type: "json" };
import {
  placementsFrom,
  stepFields,
  type DirectoryFieldRules as FieldRules,
  type DirectoryFieldWords,
} from "./data.js";
import type { DirectoryFlow, DirectoryStepLayout } from "./types.js";

type FieldKey = keyof typeof data.fields;

const WORDS: Record<FieldKey, DirectoryFieldWords> = data.fields;
const STEPS: Record<
  string,
  { title: string; intro: string; layout?: DirectoryStepLayout }
> = data.steps;

const https = { format: "https-url" } as const;
/** Shown read only and taken from the uploaded package. */
const pkg = { managedBy: "package" } as const;

function req(control: FieldRules["control"], rest: Partial<FieldRules> = {}) {
  return { control, required: true, ...rest };
}

function opt(control: FieldRules["control"], rest: Partial<FieldRules> = {}) {
  return { control, ...rest };
}

/**
 * Each field's rules, in the portal's order. Listing limits are the final
 * submission's, which are stricter than the upload's.
 */
const RULES: Record<FieldKey, FieldRules> = {
  "listing.displayName": req("text", { ...pkg, maxLength: 30 }),
  "listing.shortDescription": req("text", { ...pkg, maxLength: 30 }),
  "listing.description": req("textarea", { ...pkg, maxLength: 4000 }),
  "listing.developer": req("text", { ...pkg, maxLength: 80 }),
  "listing.name": req("text", {
    ...pkg,
    maxLength: OPENAI_FIELD_LIMITS.pluginNameMaxLength,
  }),
  // Left out of a package, the portal files the plugin under Other.
  "listing.category": opt("select", pkg),
  "listing.capabilities": opt("multi-select", {
    ...pkg,
    freeEntry: true,
    maxItems: 20,
  }),
  // The four links are required for an MCP server's review.
  "listing.website": req("text", { ...pkg, ...https }),
  "listing.support": req("text", { ...pkg, ...https }),
  "listing.privacyPolicy": req("text", { ...pkg, ...https }),
  "listing.terms": req("text", { ...pkg, ...https }),
  "listing.starterPrompts": opt("multi-select", {
    ...pkg,
    freeEntry: true,
    maxItems: 3,
  }),
  "mcp.serverUrl": req("server", { ...pkg, ...https }),
  // MCPJam's own: the token the portal shows, so a run can compare the
  // served challenge with it.
  "mcp.verificationToken": opt("text"),
  "reviewer.loginUrl": req("text", https),
  "reviewer.tenant": opt("text"),
  "reviewer.username": req("text"),
  "reviewer.passwordSecret": req("secret"),
  // An account in more than one organization needs the steps to pick one.
  "reviewer.signInSteps": opt("textarea", {
    requiredWith: ["reviewer.tenant"],
  }),
  // MCPJam's own reviewer check, beside the portal's credentials.
  "reviewer.identityTool": opt("text", {
    requiredWith: [
      "reviewer.expectedIdentity",
      "reviewer.expectedOrganization",
    ],
  }),
  "reviewer.identityArgs": opt("text"),
  "reviewer.expectedIdentityPath": opt("text", {
    requiredWith: ["reviewer.expectedIdentity"],
  }),
  "reviewer.expectedIdentity": opt("text", {
    requiredWith: ["reviewer.expectedIdentityPath"],
  }),
  "reviewer.expectedOrganizationPath": opt("text", {
    requiredWith: ["reviewer.expectedOrganization"],
  }),
  "reviewer.expectedOrganization": opt("text", {
    requiredWith: ["reviewer.expectedOrganizationPath"],
  }),
  "reviewer.fixtures": opt("pairs", {
    pairs: DIRECTORY_REVIEWER_FIXTURE_PAIRS,
  }),
  // Exactly five and three for an MCP server's first review.
  "reviewer.testCases": req("rows", {
    ...pkg,
    minItems: CASES.successCount,
    maxItems: CASES.successCount,
  }),
  "reviewer.negativeTestCases": req("rows", {
    ...pkg,
    minItems: CASES.failureCount,
    maxItems: CASES.failureCount,
  }),
  "reviewer.demoRecordingUrl": req("text", { ...pkg, format: "url" }),
  "reviewer.releaseNotes": req("textarea", pkg),
  "submit.developerIdentity": req("text"),
  "submit.attestations": req("checkbox-group", {
    declaration: true,
    minItems: data.fields["submit.attestations"].options.length,
  }),
  "submit.additionalContext": opt("textarea"),
};

export const CHATGPT_PLUGIN_FLOW: DirectoryFlow = {
  id: "chatgpt-plugin",
  directory: "openai",
  title: data.title,
  version: "2026-11-13",
  source: {
    label: "OpenAI plugin submission docs and the ChatGPT plugin portal",
    url: "https://developers.openai.com/plugins/deploy/submission",
    capturedAt: "2026-11-13",
  },
  submissionUrl: "https://platform.openai.com/plugins",
  steps: Object.keys(STEPS).map((id) => ({
    id,
    ...STEPS[id],
    fields: stepFields(id, RULES, WORDS),
  })),
  placements: placementsFrom("chatgpt-plugin.json", data.placements),
  laneSteps: data.laneSteps,
};
