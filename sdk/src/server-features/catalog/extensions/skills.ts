/**
 * Family 21: Skills (`io.modelcontextprotocol/skills`, Beta). The server
 * declares the extension; listing, retrieval and integrity come from the
 * `skills` probe and the skills list saved at connect. An empty skills/list
 * is not proof of no skills, because skills/get answers unlisted skills too.
 */

import { MCP_SKILLS_EXTENSION_ID } from "../../../mcp-client-manager/skills-dispatch.js";
import type {
  DeclaredSurface,
  FeatureDefinition,
  FeatureRuleOutcome,
  ProbeSummary,
  ProbeSurface,
} from "../../types.js";
import {
  capabilitiesOf,
  extensionOutcome,
  familyFeature,
  isComplete,
  lookupExtension,
  metaOf,
  probeBlocker,
  probeBoolean,
  probeNumber,
  recordAt,
  specAt,
  stringAt,
} from "./shared.js";

/** Prefix for `_meta` keys the Skills extension defines. */
export const SKILLS_META_PREFIX = "io.modelcontextprotocol.skills/";
const SKILL_SCHEME = "skill://";
const NOT_DECLARED =
  "Applies only when the server declares the Skills extension.";

const feature = familyFeature("skills", "beta");

function declaration(surface: DeclaredSurface): FeatureRuleOutcome {
  return extensionOutcome(
    surface,
    MCP_SKILLS_EXTENSION_ID,
    "The Skills extension"
  );
}

function isDeclared(surface: DeclaredSurface): boolean {
  return lookupExtension(surface, MCP_SKILLS_EXTENSION_ID).state === "declared";
}

/** Not applicable when the extension is known to be missing; otherwise no claim. */
function requireDeclared(
  surface: DeclaredSurface
): FeatureRuleOutcome | undefined {
  if (isDeclared(surface)) return undefined;
  const outcome = declaration(surface);
  if (outcome?.kind === "absent" && isComplete(surface, outcome.basis)) {
    return { kind: "not-applicable", reason: NOT_DECLARED };
  }
  return null;
}

function skillsProbe(
  probes: ProbeSurface
): { outcome: FeatureRuleOutcome } | { probe: ProbeSummary<"skills"> } {
  const probe = probes.skills;
  const blocked = probeBlocker(probe, "skills");
  if (blocked !== undefined || !probe) return { outcome: blocked ?? null };
  if (probeBoolean(probe.values.listed) !== true) {
    return {
      outcome: { kind: "unknown", reason: "skills/list did not answer." },
    };
  }
  return { probe };
}

/** Integrity counts from the probe: present when verified, unknown on any failure. */
function integrityOutcome(
  probes: ProbeSurface,
  failures: "digestFailures" | "frontmatterFailures",
  failureReason: (count: number) => string
): FeatureRuleOutcome {
  const read = skillsProbe(probes);
  if ("outcome" in read) return read.outcome;
  const values = read.probe.values;
  if (probeNumber(values.count) === 0) {
    return { kind: "not-applicable", reason: "The server lists no skills." };
  }
  const failed = probeNumber(values[failures]) ?? 0;
  if (failed > 0) return { kind: "unknown", reason: failureReason(failed) };
  const verified = probeNumber(values.verified) ?? 0;
  return verified > 0
    ? { kind: "present", via: "probed", count: verified }
    : { kind: "unknown", reason: "No skill was read and verified." };
}

function skillUris(surface: DeclaredSurface): string[] {
  return surface.skills
    .map((skill) => stringAt(skill, "uri"))
    .filter((uri): uri is string => uri !== undefined);
}

export const SKILLS_FEATURES: readonly FeatureDefinition[] = [
  feature({
    id: "skills.declaration",
    name: "io.modelcontextprotocol/skills declaration (directoryRead)",
    summary: "Tells hosts the server serves agent skills over MCP.",
    howTo:
      'Declare extensions["io.modelcontextprotocol/skills"] = {}, with directoryRead: true if you answer resources/directory/read.',
    spec: specAt("skills", "capability-negotiation"),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const lookup = lookupExtension(surface, MCP_SKILLS_EXTENSION_ID);
        if (
          lookup.state === "declared" &&
          lookup.settings.directoryRead === true
        ) {
          return {
            kind: "present",
            via: "advertised",
            detail: "directoryRead: true",
          };
        }
        return declaration(surface);
      },
    },
  }),
  feature({
    id: "skills.resources-capability",
    name: "resources capability declared alongside",
    summary:
      "Skills are read as resources, so the server must also declare resources.",
    howTo:
      "Declare the resources capability whenever you declare the Skills extension.",
    optional: false,
    spec: specAt("skills", "capability-negotiation"),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const blocked = requireDeclared(surface);
        if (blocked !== undefined) return blocked;
        return recordAt(capabilitiesOf(surface), "resources")
          ? { kind: "present", via: "advertised" }
          : { kind: "absent", basis: ["capabilities"] };
      },
    },
  }),
  feature({
    id: "skills.list",
    name: "skills/list",
    summary:
      "Lists the skills a host can offer, with pagination and cache hints.",
    howTo:
      "Answer skills/list with each skill's uri, frontmatter and resources manifest.",
    spec: specAt("skills", "listing-skills"),
    assessment: {
      primary: "probed",
      declared: (surface) => {
        if (surface.skills.length > 0) {
          return {
            kind: "present",
            via: "detected",
            count: surface.skills.length,
          };
        }
        return requireDeclared(surface) ?? null;
      },
      probed: (probes) => {
        const read = skillsProbe(probes);
        if ("outcome" in read) return read.outcome;
        return {
          kind: "present",
          via: "probed",
          count: probeNumber(read.probe.values.count) ?? 0,
        };
      },
    },
  }),
  feature({
    id: "skills.get",
    name: "skills/get (including unlisted skills)",
    summary:
      "Returns one skill by uri, including skills skills/list does not show.",
    howTo:
      "Answer skills/get for every skill you serve, listed or not. Open the server's skills in MCPJam to call it.",
    spec: specAt("skills", "getting-a-skill"),
    assessment: {
      primary: "observed",
      observable: true,
      declared: (surface) => requireDeclared(surface) ?? null,
    },
  }),
  feature({
    id: "skills.uri-mapping",
    name: "skill:// URI mapping",
    summary:
      "Each skill lives at skill://<path>/SKILL.md, and its last path segment is its name.",
    howTo:
      "Serve each SKILL.md at skill://<path>/SKILL.md, where the last segment of <path> is the skill name.",
    optional: false,
    spec: specAt("skills", "resource-mapping"),
    assessment: {
      primary: "probed",
      declared: (surface) => {
        const uris = skillUris(surface);
        if (uris.length === 0) return requireDeclared(surface) ?? null;
        const mapped = uris.filter(
          (uri) => uri.startsWith(SKILL_SCHEME) && uri.endsWith("/SKILL.md")
        ).length;
        if (mapped === uris.length) {
          return { kind: "present", via: "detected", count: mapped };
        }
        return {
          kind: "unknown",
          reason: `${uris.length - mapped} of ${uris.length} listed skills do not use skill://<path>/SKILL.md.`,
        };
      },
    },
  }),
  feature({
    id: "skills.digest",
    name: "Digest and size verification on read",
    summary:
      "Each file a skill lists matches the size and digest in its manifest.",
    howTo:
      "Publish the sha256 digest and byte size of every file in the skill's resources manifest.",
    optional: false,
    spec: specAt("skills", "verification-on-read"),
    assessment: {
      primary: "probed",
      probed: (probes) =>
        integrityOutcome(
          probes,
          "digestFailures",
          (count) =>
            `${count} skill files did not match their manifest digest or size.`
        ),
    },
  }),
  feature({
    id: "skills.frontmatter",
    name: "Frontmatter matches the listing",
    summary:
      "The fetched SKILL.md frontmatter matches what skills/list advertised.",
    howTo:
      "Generate the skills/list entry from the same frontmatter the SKILL.md file carries.",
    optional: false,
    spec: specAt("skills", "frontmatter-verification"),
    assessment: {
      primary: "probed",
      probed: (probes) =>
        integrityOutcome(
          probes,
          "frontmatterFailures",
          (count) =>
            `${count} skills have frontmatter that differs from their listing.`
        ),
    },
  }),
  feature({
    id: "skills.dynamic",
    name: 'Dynamic skills (resources: "dynamic")',
    summary:
      "A skill whose files are generated per request instead of listed in a manifest.",
    howTo:
      'Set resources to "dynamic" for generated skills. MCPJam lists them but declines to load content it cannot verify.',
    spec: specAt("skills", "resources"),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const count = surface.skills.filter(
          (skill) => skill.resources === "dynamic"
        ).length;
        return count > 0 ? { kind: "present", via: "detected", count } : null;
      },
    },
  }),
  feature({
    id: "skills.directory-read",
    name: "resources/directory/read",
    summary: "Lets a host list the files in a skill's directory.",
    howTo:
      "Set directoryRead: true in the Skills extension settings and answer resources/directory/read.",
    spec: specAt("skills", "reading-directories"),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const lookup = lookupExtension(surface, MCP_SKILLS_EXTENSION_ID);
        if (lookup.state !== "declared")
          return requireDeclared(surface) ?? null;
        return lookup.settings.directoryRead === true
          ? { kind: "present", via: "advertised" }
          : { kind: "absent", basis: ["capabilities"] };
      },
      probed: (probes) => {
        const probe = probes.skills;
        if (probe?.status !== "ok") return null;
        return probeBoolean(probe.values.directoryRead) === true
          ? { kind: "present", via: "probed" }
          : null;
      },
    },
  }),
  feature({
    id: "skills.instructions-pointer",
    name: "Pointer from server instructions",
    summary:
      "The server's instructions tell the model that skills are available.",
    howTo:
      "Mention your skills and how to load them in the server instructions.",
    spec: specAt("skills", "pointer-from-server-instructions"),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const blocked = requireDeclared(surface);
        if (blocked !== undefined) return blocked;
        const instructions = surface.instructions ?? "";
        if (/skill/i.test(instructions))
          return { kind: "present", via: "detected" };
        return { kind: "absent", basis: ["instructions", "capabilities"] };
      },
    },
  }),
  feature({
    id: "skills.resource-meta",
    name: "Resource _meta prefix io.modelcontextprotocol.skills/",
    summary: "Skill metadata uses keys under the extension's own _meta prefix.",
    howTo:
      "Put skill metadata under _meta keys that start with io.modelcontextprotocol.skills/.",
    spec: specAt("skills", "resource-metadata"),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const blocked = requireDeclared(surface);
        if (blocked !== undefined) return blocked;
        const items = [
          ...surface.skills,
          ...surface.resources.filter((resource) =>
            (stringAt(resource, "uri") ?? "").startsWith(SKILL_SCHEME)
          ),
        ];
        const count = items.filter((item) => {
          return Object.keys(metaOf(item) ?? {}).some((key) =>
            key.startsWith(SKILLS_META_PREFIX)
          );
        }).length;
        return count > 0
          ? { kind: "present", via: "detected", count }
          : { kind: "absent", basis: ["skills", "resources"] };
      },
    },
  }),
  feature({
    id: "skills.errors",
    name: "Errors use -32602",
    summary: "Unknown skills and bad parameters fail with Invalid params.",
    howTo:
      "Return -32602 from skills/get and resources/read for skills that do not exist.",
    spec: specAt("skills", "error-handling"),
    assessment: {
      primary: "checked",
      declared: (surface) => requireDeclared(surface) ?? null,
    },
  }),
  feature({
    id: "skills.host-consent",
    name: "Host consent before using a skill",
    summary:
      "The host asks before loading a skill and ties approval to the digests it verified.",
    howTo:
      "Hosts should ask the user before they load a server's skill.",
    owner: "host",
    spec: specAt("skills", "security-considerations"),
    assessment: { primary: "observed" },
  }),
];
