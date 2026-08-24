/**
 * Checks for a plugin migrated from a Claude Code plugin or connector.
 *
 * WHY THIS IS ITS OWN LANE'S WORTH OF CHECKS. A bundle that works perfectly as
 * a Claude plugin can be structurally unacceptable as an OpenAI one, and every
 * way it can be is invisible from the OpenAI docs alone — you only find them by
 * reading what the Claude bundle is allowed to contain. A submitter who
 * converted a working plugin gets no signal at all until the portal rejects it.
 *
 * TWO STRATA, kept apart deliberately:
 *
 *   - DETERMINISTIC, and `required`: a surface the migration guide states is
 *     unsupported, a `${user_config.*}` placeholder, a stdio transport, a
 *     `.mcpb` reference. These are decidable from the package's bytes, and a
 *     submission carrying one will be rejected.
 *   - LANGUAGE, and `heuristic`: prose in a description that names Claude, or
 *     an instruction written for a different host. Worth surfacing, never
 *     dispositive — the word "Claude" in a description is not by itself a
 *     defect, and failing a submission on a string match would be exactly the
 *     kind of false positive that teaches people to ignore a report.
 *
 * Pure data. No transport.
 */

import { openaiPolicySource } from "../manifest.js";
import { openaiPortalIssue } from "../portal-errors.js";
import type { OpenAIPluginPackageEvidence } from "../package/reader.js";
import {
  OPENAI_READINESS_INPUTS,
  type OpenAIReadinessFinding,
} from "../types.js";
import {
  informational,
  missingInput,
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

const UNSUPPORTED_SURFACES: OpenAICheckDefinition = {
  id: "openai.migration.unsupported-surfaces",
  title: "The package ships no surface the plugin directory does not run",
  lane: "plugin-package",
  class: "required",
  source: openaiPolicySource(
    "guides/submit-claude-plugin",
    "§What does not carry over",
  ),
  provenance: "static",
  intrusiveness: "passive",
};

const NO_USER_CONFIG_PLACEHOLDERS: OpenAICheckDefinition = {
  id: "openai.migration.user-config",
  title: "No configuration value depends on a ${user_config.*} placeholder",
  lane: "plugin-package",
  class: "required",
  source: openaiPolicySource("guides/submit-claude-plugin", "§Configuration"),
  provenance: "static",
  intrusiveness: "passive",
};

const NO_STDIO_TRANSPORT: OpenAICheckDefinition = {
  id: "openai.migration.stdio-transport",
  title: "No declared MCP server uses a stdio transport or a .mcpb reference",
  lane: "plugin-package",
  class: "required",
  source: openaiPolicySource("guides/submit-claude-plugin", "§MCP servers"),
  provenance: "static",
  intrusiveness: "passive",
};

const HOST_SPECIFIC_LANGUAGE: OpenAICheckDefinition = {
  id: "openai.migration.host-language",
  title: "Metadata does not read as written for a different host",
  lane: "experience-insights",
  class: "heuristic",
  source: openaiPolicySource(
    "guides/optimize-metadata",
    "§Writing for ChatGPT",
  ),
  provenance: "static",
  intrusiveness: "passive",
};

const ALL: OpenAICheckDefinition[] = [
  UNSUPPORTED_SURFACES,
  NO_USER_CONFIG_PLACEHOLDERS,
  NO_STDIO_TRANSPORT,
  HOST_SPECIFIC_LANGUAGE,
];

/** Names for a host other than the one this plugin is being submitted to. */
const OTHER_HOST_NAMES = /\b(claude|anthropic|claude code|claude desktop)\b/i;

/**
 * Whether `text` contains a `${user_config.…}` placeholder.
 *
 * A SCAN RATHER THAN A REGEX, and deliberately so. The obvious pattern —
 * `/\$\{\s*user_config\.[^}]*\}/` — is quadratic on hostile input, which CodeQL
 * flagged and was right about: it is unanchored, so the engine restarts at
 * every position, and a manifest string of many repeated `${user_config.` with
 * no closing brace makes each restart scan `[^}]*` to the end of the string.
 * The input here is a submitted `plugin.json`, so "hostile input" is not
 * hypothetical — it is the thing this module exists to inspect.
 *
 * The scan below is single-pass. The one search that could cost more than O(1)
 * — finding the closing brace — runs at most once, because if no `}` follows
 * the first `${user_config.` then none can follow a later one either: every
 * later occurrence starts further right.
 */
function containsUserConfigPlaceholder(text: string): boolean {
  let from = 0;
  for (;;) {
    const open = text.indexOf("${", from);
    if (open === -1) return false;

    let cursor = open + 2;
    // Single-character tests: no backtracking is possible in either.
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;

    if (text.startsWith("user_config.", cursor)) {
      return text.indexOf("}", cursor) !== -1;
    }
    from = open + 2;
  }
}

function walkStrings(
  value: unknown,
  visit: (text: string, path: string) => void,
  path = "",
): void {
  if (typeof value === "string") {
    visit(value, path || "(root)");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      walkStrings(entry, visit, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      walkStrings(entry, visit, path ? `${path}.${key}` : key);
    }
  }
}

export function runOpenAIMigrationChecks(
  evidence: OpenAIPluginPackageEvidence | undefined,
  stamp: OpenAICheckStamp,
): OpenAIReadinessFinding[] {
  if (!evidence) {
    return ALL.map((definition) =>
      notEvaluated(
        definition,
        stamp,
        "this run was given no package to inspect for migration leftovers",
        missingInput(OPENAI_READINESS_INPUTS.pluginBundle),
      ),
    );
  }

  const findings: OpenAIReadinessFinding[] = [];

  // ------------------------------------------------- surfaces that do not run
  findings.push(
    evidence.surfaces.length === 0
      ? satisfied(UNSUPPORTED_SURFACES, stamp)
      : violated(
          UNSUPPORTED_SURFACES,
          stamp,
          `Remove the surfaces the plugin directory does not run: ${[
            ...new Set(evidence.surfaces.map((surface) => surface.surface)),
          ].join(", ")}.`,
          {
            surfaces: evidence.surfaces,
            portalIssues: evidence.surfaces.map((surface) =>
              openaiPortalIssue(
                surface.surface === "app-config"
                  ? "exclusion-app-config-in-public-package"
                  : "exclusion-unsupported-surface",
                { subject: surface.path, observed: surface.surface },
              ),
            ),
          },
        ),
  );

  // ------------------------------------------------------------ placeholders
  //
  // AN UNREADABLE MANIFEST IS NOT A CLEAN ONE. `raw` is absent both when the
  // package ships no manifest and when the one it ships is not valid JSON, and
  // in either case `walkStrings` below visits nothing — which, left alone,
  // would report every string-scanning check as `satisfied` on a package whose
  // strings were never read. A package with a malformed `plugin.json` would
  // then pass the placeholder and stdio checks outright. "Did not run" reading
  // as "conformed" is the one failure this report cannot have; the malformed
  // manifest itself is already reported by the package lane, so this says only
  // that these two checks could not be decided.
  const document = evidence.manifest?.raw;
  if (!document) {
    for (const definition of [
      NO_USER_CONFIG_PLACEHOLDERS,
      NO_STDIO_TRANSPORT,
      HOST_SPECIFIC_LANGUAGE,
    ]) {
      findings.push(
        notEvaluated(
          definition,
          stamp,
          evidence.manifest
            ? "the package's manifest is not readable as JSON, so none of its strings were scanned"
            : "the package ships no manifest, so there were no declared strings to scan",
          missingInput(OPENAI_READINESS_INPUTS.pluginBundle),
        ),
      );
    }
    return findings;
  }

  const placeholders: string[] = [];
  const stdio: string[] = [];
  const mcpb: string[] = [];
  const hostLanguage: string[] = [];

  walkStrings(document, (text, path) => {
    if (containsUserConfigPlaceholder(text)) placeholders.push(path);
    if (/\.mcpb\b/i.test(text)) mcpb.push(path);
    if (OTHER_HOST_NAMES.test(text)) hostLanguage.push(path);
  });

  // A stdio server is declared by a `command`, not by a URL. The distinction is
  // structural rather than textual: a public submission's server has to be
  // reachable over the network, and a command is a process on somebody's laptop.
  const servers = document.mcpServers;
  walkStrings(servers, (text, path) => {
    if (/(^|\.)command$/.test(path) || /^stdio$/i.test(text)) stdio.push(path);
  });

  findings.push(
    placeholders.length === 0
      ? satisfied(NO_USER_CONFIG_PLACEHOLDERS, stamp)
      : violated(
          NO_USER_CONFIG_PLACEHOLDERS,
          stamp,
          `Resolve these \`\${user_config.*}\` placeholders before submitting; nothing fills them in on the directory side: ${placeholders.join(", ")}.`,
          { paths: placeholders },
        ),
  );

  findings.push(
    stdio.length === 0 && mcpb.length === 0
      ? satisfied(NO_STDIO_TRANSPORT, stamp)
      : violated(
          NO_STDIO_TRANSPORT,
          stamp,
          "A public submission's MCP server must be reachable over HTTPS; a stdio command or a `.mcpb` reference is a process on somebody's machine.",
          { stdio, mcpb },
        ),
  );

  // ---------------------------------------------------------------- language
  //
  // `informational`, `heuristic`, experience-insights: three guards, because
  // the word "Claude" in a description is not by itself a defect.
  findings.push(
    informational(
      HOST_SPECIFIC_LANGUAGE,
      stamp,
      { paths: hostLanguage },
      hostLanguage.length === 0
        ? "No metadata field names another host."
        : `These fields name another host: ${hostLanguage.join(", ")}. Worth rereading for a ChatGPT audience — not a defect on its own.`,
    ),
  );

  return findings;
}
