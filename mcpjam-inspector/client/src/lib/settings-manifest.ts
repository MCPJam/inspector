import { matchAppRoute } from "./app-routes";
import {
  buildProjectPath,
  isAppRelativeTarget,
  stripProjectFromPath,
} from "./project-route";

export interface SettingsContext {
  organizationId?: string | null;
  projectId?: string | null;
  authenticated: boolean;
  remoteProject: boolean;
  personalOrganization?: boolean;
  features?: { github?: boolean; discord?: boolean; observability?: boolean };
}
export type SettingsGroup = "Personal" | "Organization" | "Project" | "App";
interface SettingsDestination {
  id: string;
  group: SettingsGroup;
  label: string;
  path: (context: SettingsContext) => string;
  matches: (path: string) => boolean;
  aliases: string[];
  sections?: {
    target: string;
    label: string;
    aliases: string[];
    visible?: (context: SettingsContext) => boolean;
  }[];
  visible?: (context: SettingsContext) => boolean;
}
const personal = (
  id: string,
  label: string,
  suffix: string,
  aliases: string[],
): SettingsDestination => ({
  id: `personal-${id}`,
  group: "Personal",
  label,
  aliases,
  path: () => `/settings${suffix}`,
  matches: (p) => p === `/settings${suffix}`,
});
const org = (
  id: string,
  label: string,
  suffix: string,
  aliases: string[],
): SettingsDestination => ({
  id: `org-${id}`,
  group: "Organization",
  label,
  aliases,
  path: (c) =>
    `/organizations/${encodeURIComponent(c.organizationId!)}${suffix}`,
  matches: (p) => new RegExp(`^/organizations/[^/]+${suffix}$`).test(p),
});
const project = (
  id: string,
  label: string,
  suffix: string,
  aliases: string[],
): SettingsDestination => ({
  id: `project-${id}`,
  group: "Project",
  label,
  aliases,
  path: (c) => buildProjectPath(c.projectId!, `/project-settings${suffix}`),
  matches: (p) => p === `/project-settings${suffix}`,
});
export const SETTINGS_DESTINATIONS: readonly SettingsDestination[] = [
  {
    ...personal("profile", "Profile", "", [
      "name",
      "email",
      "photo",
      "avatar",
      "profile picture",
    ]),
    matches: (path) => path === "/settings" || path === "/profile",
  },
  personal("appearance", "Appearance", "/appearance", [
    "theme",
    "dark mode",
    "light mode",
  ]),
  personal("api-keys", "API Keys", "/api-keys", [
    "create key",
    "revoke key",
    "SDK",
    "MCPJAM_API_KEY",
  ]),
  {
    ...personal("support", "Support", "/support", [
      "help",
      "contact",
      "Discord",
      "documentation",
      "report a bug",
    ]),
    group: "App",
  },
  {
    ...personal("about", "About MCPJam", "/about", ["version"]),
    group: "App",
  },
  org("general", "General", "", [
    "organization name",
    "logo",
    "leave organization",
    "delete organization",
  ]),
  {
    ...org("members", "Members & sharing", "/members", [
      "invite",
      "roles",
      "ownership",
      "seats",
      "pending members",
      "sharing policy",
      "public links",
    ]),
    matches: (path) => /^\/organizations\/[^/]+\/(members|sharing)$/.test(path),
  },
  org("api-keys", "API Keys", "/api-keys", ["organization keys", "key owners"]),
  {
    ...org("byok", "AI providers", "/models", [
      "BYOK",
      "models",
      "providers",
      "custom providers",
      "model usage",
      "OpenAI",
      "Anthropic",
    ]),
    matches: (path) =>
      /^\/organizations\/[^/]+\/models(?:\/usage)?$/.test(path),
  },
  {
    id: "org-integrations",
    group: "Organization",
    label: "Integrations",
    aliases: [],
    path: () => "/settings/integrations",
    sections: [
      {
        target: "github",
        label: "GitHub Checks",
        aliases: ["pull requests", "checks"],
        visible: (c) => c.features?.github === true,
      },
      { target: "slack", label: "Slack", aliases: ["channels"] },
      {
        target: "discord",
        label: "Discord",
        aliases: ["bot"],
        visible: (c) => c.features?.discord === true,
      },
      {
        target: "observability",
        label: "Observability",
        aliases: ["OTLP", "traces", "Honeycomb", "Coralogix"],
        visible: (c) => c.features?.observability === true,
      },
    ],
    matches: (p) =>
      p.startsWith("/settings/integrations") ||
      /^\/organizations\/[^/]+\/(slack|discord|observability|integrations)$/.test(
        p,
      ),
  },
  org("plans", "Plans", "/plans", ["compare plans", "upgrade", "subscription"]),
  {
    ...org("billing", "Usage & billing", "/billing", [
      "credits",
      "purchases",
      "charges",
      "subscription",
      "plans",
      "auto-top-up",
    ]),
    matches: (p) =>
      /^\/organizations\/[^/]+\/billing(?:\/usage)?$/.test(p) ||
      p === "/billing",
  },
  org("audit-log", "Audit log", "/audit-log", ["activity", "CSV export"]),
  org("data-management", "Data management", "/data-management", [
    "retention",
    "enterprise",
  ]),
  {
    ...project("general", "General", "", [
      "project name",
      "icon",
      "description",
      "delete project",
    ]),
    sections: [
      {
        target: "test-identity",
        label: "Test identity defaults",
        aliases: ["XAA", "subject", "test IdP"],
      },
    ],
  },
  {
    ...project("members", "Members & sharing", "/members", [
      "project membership",
      "share project",
    ]),
    visible: (c) => c.authenticated,
  },
  {
    ...project("secrets", "Environment variables", "/secrets", [
      "personal secrets",
      "project-shared secrets",
    ]),
    visible: (c) => c.authenticated && c.remoteProject,
  },
];
export function visibleSettings(context: SettingsContext) {
  return SETTINGS_DESTINATIONS.filter(
    (d) =>
      (d.group !== "Organization" || !!context.organizationId) &&
      (d.group !== "Project" || !!context.projectId) &&
      (d.visible?.(context) ?? true),
  );
}
export function resolveSettingsDestination(path: string) {
  const logical = stripProjectFromPath(path.split(/[?#]/)[0]);
  return SETTINGS_DESTINATIONS.find((d) => d.matches(logical));
}
export function settingsPath(
  id: string,
  context: SettingsContext,
  search = "",
  target?: string,
) {
  const destination = SETTINGS_DESTINATIONS.find((d) => d.id === id)!;
  const query = new URLSearchParams(search);
  query.delete("setting");
  if (target) query.set("setting", target);
  return destination.path(context) + (query.size ? `?${query}` : "");
}
export function searchSettings(query: string, context: SettingsContext) {
  const q = query.trim().toLowerCase();
  return visibleSettings(context)
    .flatMap((destination) => [
      {
        destination,
        label: destination.label,
        aliases: destination.aliases,
        target: undefined as string | undefined,
      },
      ...(destination.sections ?? [])
        .filter(
          (s) =>
            (s.target !== "test-identity" || context.remoteProject) &&
            (s.visible?.(context) ?? true),
        )
        .map((s) => ({ destination, ...s })),
    ])
    .map((result) => {
      const label = result.label.toLowerCase();
      const terms = [label, ...result.aliases.map((a) => a.toLowerCase())];
      const rank =
        label === q
          ? 0
          : label.startsWith(q)
            ? 1
            : terms.some((t) => t.includes(q))
              ? 2
              : 3;
      return { ...result, rank };
    })
    .filter((r) => r.rank < 3)
    .sort((a, b) => a.rank - b.rank);
}
export interface SettingsReturnLocation {
  path: string;
  organizationId?: string | null;
  projectId?: string | null;
}
export function settingsBackTarget(
  previous: SettingsReturnLocation | null,
  context: SettingsContext,
  fallback: string,
) {
  return previous &&
    previous.path.startsWith("/") &&
    isAppRelativeTarget(previous.path) &&
    matchAppRoute(stripProjectFromPath(previous.path).split(/[?#]/)[0])
      ?.kind === "screen" &&
    !resolveSettingsDestination(previous.path) &&
    previous.organizationId === context.organizationId &&
    previous.projectId === context.projectId
    ? previous.path
    : fallback;
}
