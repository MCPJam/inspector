/**
 * The captured MCP-server skills an environment-backed study carries on its
 * runtime config (`environment.serverSkills`), in the resolved environment's
 * row shape (`ResolvedEnvironmentRuntime.serverSkills`), so a study's turn
 * plans them like any environment's.
 *
 * Additive, like the rest of the scenario payload (`readScenarioEnvironment`):
 * a malformed entry is dropped, and a backend that predates the field sends
 * none.
 */
import type { ResolvedEnvironmentRuntime } from "../services/environments/runtime.js";

export type ScenarioServerSkill = NonNullable<
  ResolvedEnvironmentRuntime["serverSkills"]
>[number];

const TEXT_FIELDS = [
  "serverSkillId",
  "versionId",
  "serverId",
  "serverSlug",
  "serverLabel",
  "ref",
  "skillUri",
  "name",
  "description",
  "content",
  "contentSha256",
  "versionHash",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readScenarioServerSkills(
  config: unknown,
): ScenarioServerSkill[] {
  const environment = isRecord(config) ? config.environment : undefined;
  const raw = isRecord(environment) ? environment.serverSkills : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ScenarioServerSkill[] => {
    if (
      !isRecord(entry) ||
      TEXT_FIELDS.some((key) => typeof entry[key] !== "string") ||
      typeof entry.versionNumber !== "number" ||
      typeof entry.capturedAt !== "number"
    ) {
      return [];
    }
    const text = Object.fromEntries(
      TEXT_FIELDS.map((key) => [key, String(entry[key])]),
    ) as Record<(typeof TEXT_FIELDS)[number], string>;
    const files = Array.isArray(entry.files)
      ? entry.files.flatMap((file) =>
          isRecord(file) &&
          typeof file.path === "string" &&
          typeof file.size === "number"
            ? [
                {
                  path: file.path,
                  size: file.size,
                  url: typeof file.url === "string" ? file.url : null,
                },
              ]
            : [],
        )
      : [];
    return [
      {
        ...text,
        versionNumber: entry.versionNumber,
        capturedAt: entry.capturedAt,
        ...(isRecord(entry.provenance) ? { provenance: entry.provenance } : {}),
        files,
      },
    ];
  });
}
