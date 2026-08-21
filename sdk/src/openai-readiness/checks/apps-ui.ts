/**
 * Plugin UI checks.
 *
 * WHAT IS DERIVED. Whether a UI resource declares the right MIME profile, and
 * whether its HTML renders at all, is what the apps-conformance suite already
 * grades. Those findings cite it rather than re-observing, for the usual
 * reason: two implementations of one rule are two opinions about the same
 * server.
 *
 * WHAT IS OPENAI'S, and therefore graded here:
 *
 *   - `_meta.ui.domain` is REQUIRED and UNIQUE. Required because the host keys
 *     its sandbox on it; unique because two resources sharing a domain share a
 *     sandbox, and then one template can read the other's storage. The
 *     uniqueness half is the one a check is likely to miss, and it is the half
 *     with a security consequence.
 *   - the CSP allowlist must be EXACT: every domain the template actually loads
 *     has to appear, and a domain that appears without being loaded is a hole
 *     nobody needed.
 *   - `outputSchema` has to describe what the template is handed, because the
 *     model reads the schema and the template reads the data, and a divergence
 *     is invisible until a user sees an empty widget.
 *   - a tool must remain useful with NO UI at all. Not every surface renders,
 *     and a tool whose text response is meaningless is broken in Codex.
 *
 * Pure data. No transport.
 */

import { openaiPolicySource } from "../manifest.js";
import { OPENAI_APP_HTML_MIME } from "../profile.js";
import { openaiPortalIssue } from "../portal-errors.js";
import {
  OPENAI_READINESS_INPUTS,
  type OpenAIReadinessFinding,
} from "../types.js";
import {
  derivedFrom,
  informational,
  missingInput,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

/** One UI resource the server serves, as the scan saw it. */
export interface OpenAIUiResourceEvidence {
  uri: string;
  mimeType?: string;
  /** `_meta.ui.domain`. */
  domain?: string;
  /** Domains named in the resource's declared content security policy. */
  declaredCspDomains?: string[];
  /** Domains the rendered template was observed loading. */
  observedDomains?: string[];
  /** Domains the template embeds in a frame. */
  frameDomains?: string[];
  /** Tools that reference this resource. */
  referencedByTools?: string[];
  /** Whether the tool's `outputSchema` covers the data the template renders. */
  outputSchemaCoversRenderedData?: boolean;
  /** Whether the tool's text response is useful with no UI rendered. */
  usefulWithoutUi?: boolean;
}

export interface OpenAIAppsUiEvidence {
  resources?: OpenAIUiResourceEvidence[];
  /** Screenshots the submission supplies, from the profile. */
  screenshotCount?: number;
}

const MIME_PROFILE: OpenAICheckDefinition = {
  id: "openai.ui.mime",
  title: `Every UI resource declares ${OPENAI_APP_HTML_MIME}`,
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: openaiPolicySource("build/chatgpt-ui", "§Resources"),
  provenance: "wire",
};

const DOMAIN_PRESENT: OpenAICheckDefinition = {
  id: "openai.ui.domain-present",
  title: "Every UI resource declares _meta.ui.domain",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: openaiPolicySource("reference", "§UI metadata"),
  provenance: "wire",
};

const DOMAIN_UNIQUE: OpenAICheckDefinition = {
  id: "openai.ui.domain-unique",
  title: "No two UI resources share a _meta.ui.domain",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("reference", "§UI metadata"),
  provenance: "wire",
};

const CSP_EXACT: OpenAICheckDefinition = {
  id: "openai.ui.csp-exact",
  title: "The content security policy lists exactly the domains the UI loads",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("concepts/ui-guidelines", "§Content security"),
  provenance: "wire",
};

const OUTPUT_SCHEMA_CONSISTENT: OpenAICheckDefinition = {
  id: "openai.ui.output-schema",
  title: "outputSchema describes the data the template renders",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("build/chatgpt-ui", "§Structured output"),
  provenance: "static",
  intrusiveness: "passive",
};

const USEFUL_WITHOUT_UI: OpenAICheckDefinition = {
  id: "openai.ui.useful-without-ui",
  title: "Tools remain useful where no UI is rendered",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("concepts/ui-guidelines", "§When to use UI"),
  provenance: "static",
  intrusiveness: "passive",
};

const SCREENSHOTS_WITH_UI: OpenAICheckDefinition = {
  id: "openai.ui.screenshots",
  title: "Screenshots accompany a submission that renders a UI template",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission-errors", "§Images"),
  provenance: "declared",
  intrusiveness: "passive",
};

const ALL: OpenAICheckDefinition[] = [
  MIME_PROFILE,
  DOMAIN_PRESENT,
  DOMAIN_UNIQUE,
  CSP_EXACT,
  OUTPUT_SCHEMA_CONSISTENT,
  USEFUL_WITHOUT_UI,
  SCREENSHOTS_WITH_UI,
];

export function runOpenAIAppsUiChecks(
  evidence: OpenAIAppsUiEvidence | undefined,
  stamp: OpenAICheckStamp,
): OpenAIReadinessFinding[] {
  if (!evidence?.resources) {
    return ALL.map((definition) =>
      notEvaluated(
        definition,
        stamp,
        "this run observed no UI resources",
        missingInput(OPENAI_READINESS_INPUTS.serverUrl),
      ),
    );
  }

  const resources = evidence.resources;

  if (resources.length === 0) {
    // A plugin with no UI is an ordinary shape, and most of these rules simply
    // do not apply to it. The screenshot rule INVERTS: screenshots without a
    // template are the exclusion the portal reports.
    const findings = ALL.filter(
      (definition) => definition !== SCREENSHOTS_WITH_UI,
    ).map((definition) =>
      notApplicable(
        definition,
        stamp,
        "this submission renders no UI template",
      ),
    );
    findings.push(
      (evidence.screenshotCount ?? 0) > 0
        ? violated(
            SCREENSHOTS_WITH_UI,
            stamp,
            "Screenshots were supplied for a submission that renders no UI template; remove them or add the template.",
            {
              portalIssues: [
                openaiPortalIssue("exclusion-screenshots-without-ui", {
                  observed: evidence.screenshotCount,
                }),
              ],
            },
          )
        : notApplicable(
            SCREENSHOTS_WITH_UI,
            stamp,
            "this submission renders no UI template and supplies no screenshots",
          ),
    );
    return findings;
  }

  const findings: OpenAIReadinessFinding[] = [];

  const wrongMime = resources.filter(
    (resource) =>
      (resource.mimeType ?? "").replace(/\s+/g, "").toLowerCase() !==
      OPENAI_APP_HTML_MIME,
  );
  findings.push(
    wrongMime.length === 0
      ? derivedFrom(
          satisfied(MIME_PROFILE, stamp, { resources: resources.length }),
          "apps-conformance:apps-resource-mime",
        )
      : violated(
          MIME_PROFILE,
          stamp,
          `Declare \`${OPENAI_APP_HTML_MIME}\` on: ${wrongMime.map((resource) => resource.uri).join(", ")}. \`text/html\` alone does not tell the host the payload is an app.`,
          {
            portalIssues: wrongMime.map((resource) =>
              openaiPortalIssue("mcp-ui-mime-invalid", {
                subject: resource.uri,
                observed: resource.mimeType,
              }),
            ),
          },
        ),
  );

  const noDomain = resources.filter((resource) => !resource.domain);
  findings.push(
    noDomain.length === 0
      ? satisfied(DOMAIN_PRESENT, stamp, { resources: resources.length })
      : violated(
          DOMAIN_PRESENT,
          stamp,
          `Declare \`_meta.ui.domain\` on: ${noDomain.map((resource) => resource.uri).join(", ")}.`,
          {
            portalIssues: noDomain.map((resource) =>
              openaiPortalIssue("mcp-ui-domain-missing", {
                subject: resource.uri,
              }),
            ),
          },
        ),
  );

  // The half a check is likely to miss, and the half with a security
  // consequence: two resources sharing a domain share a sandbox, and then one
  // template can read the other's storage.
  const byDomain = new Map<string, string[]>();
  for (const resource of resources) {
    if (!resource.domain) continue;
    byDomain.set(resource.domain, [
      ...(byDomain.get(resource.domain) ?? []),
      resource.uri,
    ]);
  }
  const shared = [...byDomain.entries()].filter(([, uris]) => uris.length > 1);
  findings.push(
    shared.length === 0
      ? satisfied(DOMAIN_UNIQUE, stamp, { domains: byDomain.size })
      : violated(
          DOMAIN_UNIQUE,
          stamp,
          `These domains are declared by more than one resource, so those templates share a sandbox: ${shared
            .map(([domain, uris]) => `${domain} (${uris.join(", ")})`)
            .join("; ")}.`,
          {
            portalIssues: shared.map(([domain]) =>
              openaiPortalIssue("mcp-ui-domain-duplicate", { subject: domain }),
            ),
          },
        ),
  );

  // ------------------------------------------------------------------- CSP
  const cspProblems = resources
    .map((resource) => {
      const declared = new Set(resource.declaredCspDomains ?? []);
      const observed = resource.observedDomains;
      if (observed === undefined) return undefined;
      const missing = observed.filter((domain) => !declared.has(domain));
      const unused = [...declared].filter(
        (domain) => !observed.includes(domain),
      );
      return missing.length > 0 || unused.length > 0
        ? { uri: resource.uri, missing, unused }
        : undefined;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  const anyObserved = resources.some(
    (resource) => resource.observedDomains !== undefined,
  );

  findings.push(
    !anyObserved
      ? notEvaluated(
          CSP_EXACT,
          stamp,
          "no template was rendered, so the domains it actually loads were never observed and the allowlist could not be compared against them",
          { requiresRender: true },
        )
      : cspProblems.length === 0
        ? satisfied(CSP_EXACT, stamp, { resources: resources.length })
        : violated(
            CSP_EXACT,
            stamp,
            // BOTH directions. A missing domain breaks the template; an unused
            // one is a hole nobody needed, and only the first is visible from
            // watching it work.
            cspProblems
              .map(
                (problem) =>
                  `${problem.uri}: ${
                    problem.missing.length > 0
                      ? `loads ${problem.missing.join(", ")} without allowlisting them`
                      : ""
                  }${problem.missing.length > 0 && problem.unused.length > 0 ? "; " : ""}${
                    problem.unused.length > 0
                      ? `allowlists ${problem.unused.join(", ")} without loading them`
                      : ""
                  }`,
              )
              .join(". "),
            {
              problems: cspProblems,
              portalIssues: cspProblems
                .filter((problem) => problem.missing.length > 0)
                .map((problem) =>
                  openaiPortalIssue("mcp-csp-domain-missing", {
                    subject: problem.uri,
                    observed: problem.missing.join(", "),
                  }),
                ),
            },
          ),
  );

  // -------------------------------------------------------- schema and text
  const schemaKnown = resources.filter(
    (resource) => resource.outputSchemaCoversRenderedData !== undefined,
  );
  const schemaBad = schemaKnown.filter(
    (resource) => resource.outputSchemaCoversRenderedData === false,
  );
  findings.push(
    schemaKnown.length === 0
      ? notEvaluated(
          OUTPUT_SCHEMA_CONSISTENT,
          stamp,
          "no run compared a tool's outputSchema against the data its template renders",
        )
      : schemaBad.length === 0
        ? satisfied(OUTPUT_SCHEMA_CONSISTENT, stamp, {
            compared: schemaKnown.length,
          })
        : violated(
            OUTPUT_SCHEMA_CONSISTENT,
            stamp,
            `These templates render data their tool's outputSchema does not describe: ${schemaBad
              .map((resource) => resource.uri)
              .join(
                ", ",
              )}. The model reads the schema and the template reads the data; a divergence is invisible until a user sees an empty widget.`,
            { resources: schemaBad.map((resource) => resource.uri) },
          ),
  );

  const usefulKnown = resources.filter(
    (resource) => resource.usefulWithoutUi !== undefined,
  );
  const notUseful = usefulKnown.filter(
    (resource) => resource.usefulWithoutUi === false,
  );
  findings.push(
    usefulKnown.length === 0
      ? notEvaluated(
          USEFUL_WITHOUT_UI,
          stamp,
          "whether a tool's text response stands on its own is a judgement about content this run did not make",
        )
      : notUseful.length === 0
        ? satisfied(USEFUL_WITHOUT_UI, stamp, { compared: usefulKnown.length })
        : violated(
            USEFUL_WITHOUT_UI,
            stamp,
            `These tools are meaningless where no UI renders — Codex among them: ${notUseful
              .map(
                (resource) =>
                  resource.referencedByTools?.join(", ") ?? resource.uri,
              )
              .join("; ")}.`,
            { resources: notUseful.map((resource) => resource.uri) },
          ),
  );

  findings.push(
    (evidence.screenshotCount ?? 0) > 0
      ? satisfied(SCREENSHOTS_WITH_UI, stamp, {
          screenshots: evidence.screenshotCount,
        })
      : informational(
          SCREENSHOTS_WITH_UI,
          stamp,
          { screenshots: 0 },
          "This submission renders a UI template and supplies no screenshots; a reviewer will have nothing to look at.",
        ),
  );

  return findings;
}
