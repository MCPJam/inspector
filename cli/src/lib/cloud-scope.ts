/**
 * Typed Cloud resource scope and the project-selector precedence used by
 * project-scoped `mcpjam cloud` commands.
 *
 * Precedence:
 *   1. `--project`
 *   2. explicit `project` in a `--file` / `--json` input document
 *   3. `MCPJAM_PROJECT`
 *   4. nearest valid `.mcpjam/project.json`
 *   5. automatic SDK selection (most recently updated accessible project)
 *
 * `MCPJAM_PROJECT_ID` is SDK eval-reporting legacy and never selects a Cloud
 * CLI project. Empty `--project` / `MCPJAM_PROJECT` are usage errors, not a
 * fall-through to automatic.
 */
import {
  readRequiredProjectLink,
  type ProjectLinkIo,
} from "./project-link.js";
import { usageError } from "./output.js";

export type CloudScope =
  | { kind: "account" }
  | { kind: "organization"; organization?: string }
  | { kind: "all-projects" }
  | {
      kind: "project";
      selector?: string;
      source: "flag" | "input" | "env" | "link" | "automatic";
      linkPath?: string;
      linkedName?: string;
    };

export type ProjectCloudScope = Extract<CloudScope, { kind: "project" }>;

export type ResolveProjectSelectorOptions = {
  flagProject?: string | null;
  /**
   * Override the empty-`--project` usage text. `cloud link` has a positional
   * project argument, not `--project`, so it must name that argument.
   */
  emptyFlagMessage?: string;
  inputProject?: string | null;
  env?: NodeJS.ProcessEnv;
  ignoreLink?: boolean;
} & ProjectLinkIo;

function present(value: string | null | undefined): value is string {
  return typeof value === "string";
}

function requireNonEmpty(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw usageError(message);
  }
  return trimmed;
}

export function resolveProjectSelector(
  options: ResolveProjectSelectorOptions = {}
): ProjectCloudScope {
  if (present(options.flagProject)) {
    return {
      kind: "project",
      selector: requireNonEmpty(
        options.flagProject,
        options.emptyFlagMessage ??
          "Option --project cannot be empty. Omit it to use MCPJAM_PROJECT, a project link, or automatic selection."
      ),
      source: "flag",
    };
  }

  if (present(options.inputProject)) {
    return {
      kind: "project",
      selector: requireNonEmpty(
        options.inputProject,
        'Input document "project" cannot be empty. Omit it to use MCPJAM_PROJECT, a project link, or automatic selection.'
      ),
      source: "input",
    };
  }

  const env = options.env ?? process.env;
  if (present(env.MCPJAM_PROJECT)) {
    return {
      kind: "project",
      selector: requireNonEmpty(
        env.MCPJAM_PROJECT,
        "MCPJAM_PROJECT cannot be empty. Unset it to use a project link or automatic selection."
      ),
      source: "env",
    };
  }

  if (!options.ignoreLink) {
    const linked = readRequiredProjectLink(options);
    if (linked) {
      return {
        kind: "project",
        selector: linked.link.project.id,
        source: "link",
        linkPath: linked.path,
        linkedName: linked.link.project.name,
      };
    }
  }

  return { kind: "project", source: "automatic" };
}

/**
 * Resolve the selector a project-scoped Cloud operation should send, plus the
 * typed scope for status / stale-link hints. Does not inject into
 * `options.project` — call sites with an input document pass `inputProject`
 * separately so a flag-less JSON body still beats env/link.
 */
export function resolveCloudProjectArgs(
  options: { project?: string },
  extra: Omit<ResolveProjectSelectorOptions, "flagProject"> = {}
): { project?: string; projectScope: ProjectCloudScope } {
  const projectScope = resolveProjectSelector({
    flagProject: options.project,
    ...extra,
  });
  return {
    ...(projectScope.selector !== undefined
      ? { project: projectScope.selector }
      : {}),
    projectScope,
  };
}

export function describeProjectScope(scope: ProjectCloudScope): string {
  switch (scope.source) {
    case "automatic":
      return "automatic (most recently updated)";
    case "flag":
      return `flag (${scope.selector})`;
    case "input":
      return `input (${scope.selector})`;
    case "env":
      return `env (${scope.selector})`;
    case "link":
      return `link (${scope.linkedName ?? scope.selector})`;
  }
}

export function isProjectSelectorFailure(message: string): boolean {
  return (
    /^Project ["']/.test(message) ||
    message.startsWith("No accessible MCPJam projects")
  );
}

export function appendProjectLinkHint(
  message: string,
  scope: ProjectCloudScope | undefined
): string {
  if (
    !scope ||
    scope.source !== "link" ||
    !scope.linkPath ||
    !isProjectSelectorFailure(message)
  ) {
    return message;
  }
  return `${message}\nSelector came from ${scope.linkPath} — re-run \`mcpjam cloud link\`.`;
}
