/**
 * `mcpjam cloud link` and `mcpjam cloud status`.
 *
 * Link writes a committed, secret-free `.mcpjam/project.json`. Status is
 * zero-network: credential source, deployment, project selector, and link
 * validity. An invalid link still emits the structured report, then exits 1.
 */
import { existsSync } from "node:fs";
import type { Command } from "commander";
import {
  projectResolutionError,
  resolveProject,
} from "@mcpjam/sdk/platform";
import { describeCloudCredential } from "../lib/credential-describe.js";
import {
  describeProjectScope,
  resolveProjectSelector,
} from "../lib/cloud-scope.js";
import {
  apiUrlsMatch,
  inspectProjectLink,
  projectLinkPathForDir,
  projectLinkWriteDir,
  removeProjectLinkFile,
  writeProjectLink,
  type ProjectLink,
} from "../lib/project-link.js";
import { setProcessExitCode, usageError, writeResult } from "../lib/output.js";
import {
  platformOptionsOf,
  runPlatformOperation,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { getGlobalOptions } from "../lib/server-config.js";

type LinkOptions = PlatformOptions & {
  here?: boolean;
  remove?: boolean;
};

type CloudStatusReport = {
  ok: boolean;
  credential: {
    source: string;
    kind: string;
    valid: boolean | null;
    error?: string;
    redactedKey?: string;
    envShadowsOauth: boolean;
    storedOauthPresent: boolean;
  };
  deployment: {
    apiUrl: string;
    source: string;
    valid: boolean;
    error?: string;
  };
  project: {
    selector: string | null;
    source: string;
    description: string;
  };
  link: {
    path: string | null;
    valid: boolean | null;
    project?: { id: string; name: string };
    organizationId?: string;
    apiUrl?: string;
    apiUrlMatchesDeployment?: boolean;
    error?: string;
  };
  warnings: string[];
};

function mcpjamProjectIdWarning(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.MCPJAM_PROJECT_ID?.trim()) {
    return undefined;
  }
  return "MCPJAM_PROJECT_ID is set; it is used only for SDK eval reporting and does not select a Cloud CLI project.";
}

function nearestLinkPath(): string | undefined {
  const inspection = inspectProjectLink();
  return inspection.status === "missing" ? undefined : inspection.path;
}

export function registerCloudLinkCommands(cloud: Command): void {
  cloud
    .command("status")
    .description(
      "Show how this CLI would authenticate and which Cloud project it would use, without calling the network."
    )
    .action((_options: PlatformOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command);
      const platform = platformOptionsOf(command);
      const env = process.env;
      const warnings: string[] = [];
      const { credential, deployment } = describeCloudCredential(platform, {
        env,
      });

      const projectIdWarning = mcpjamProjectIdWarning(env);
      if (projectIdWarning) {
        warnings.push(projectIdWarning);
      }
      if (credential.envShadowsOauth) {
        warnings.push(
          "MCPJAM_API_KEY is set, so it shadows the stored OAuth login for Cloud commands."
        );
      }

      const inspection = inspectProjectLink();
      let ok = credential.valid !== false && deployment.valid;
      let projectSelectorFailed = false;
      let projectScopeDescription = describeProjectScope({
        kind: "project",
        source: "automatic",
      });
      let projectSource = "automatic";
      let projectSelector: string | null = null;

      try {
        const scope = resolveProjectSelector({ env });
        projectSource = scope.source;
        projectSelector = scope.selector ?? null;
        projectScopeDescription = describeProjectScope(scope);
      } catch (error) {
        ok = false;
        projectSelectorFailed = true;
        projectSource = "unresolved";
        warnings.push(error instanceof Error ? error.message : String(error));
      }

      const link: CloudStatusReport["link"] =
        inspection.status === "missing"
          ? { path: null, valid: null }
          : inspection.status === "invalid"
            ? {
                path: inspection.path,
                valid: false,
                error: inspection.error,
              }
            : {
                path: inspection.path,
                valid: true,
                project: inspection.link.project,
                ...(inspection.link.organizationId
                  ? { organizationId: inspection.link.organizationId }
                  : {}),
                apiUrl: inspection.link.apiUrl,
                apiUrlMatchesDeployment: apiUrlsMatch(
                  inspection.link.apiUrl,
                  deployment.apiUrl
                ),
              };

      if (inspection.status === "invalid") {
        ok = false;
      }

      if (link.valid === true && link.apiUrlMatchesDeployment === false) {
        warnings.push(
          `Project link apiUrl (${link.apiUrl}) does not match the active deployment (${deployment.apiUrl}). The active deployment's API URL is used; the link's project selector remains active.`
        );
      }

      const report: CloudStatusReport = {
        ok,
        credential: {
          source: credential.source,
          kind: credential.kind,
          valid: credential.valid,
          ...(credential.error ? { error: credential.error } : {}),
          ...(credential.redactedKey
            ? { redactedKey: credential.redactedKey }
            : {}),
          envShadowsOauth: credential.envShadowsOauth,
          storedOauthPresent: credential.storedOauthPresent,
        },
        deployment: {
          apiUrl: deployment.apiUrl,
          source: deployment.source,
          valid: deployment.valid,
          ...(deployment.error ? { error: deployment.error } : {}),
        },
        project: {
          selector: projectSelector,
          source: projectSource,
          description: projectSelectorFailed
            ? "unresolved"
            : projectScopeDescription,
        },
        link,
        warnings,
      };

      writeResult(report, globalOptions.format);
      if (!ok) {
        setProcessExitCode(1);
      }
    });

  cloud
    .command("link")
    .description(
      "Pin this directory to a Cloud project by writing .mcpjam/project.json. The file contains no secrets and is committed by default; per-developer setups may gitignore it."
    )
    .argument("[project]", "Project name or ID to pin")
    .option(
      "--here",
      "Write .mcpjam/project.json in the current directory instead of the Git worktree root"
    )
    .option(
      "--remove",
      "Remove the nearest project link (current directory with --here)"
    )
    .action(
      async (
        project: string | undefined,
        options: LinkOptions,
        command: Command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const platform = platformOptionsOf(command);

        if (options.remove) {
          if (project !== undefined) {
            throw usageError("Do not pass a project argument with --remove.");
          }
          const filePath = options.here
            ? projectLinkPathForDir(projectLinkWriteDir({ here: true }))
            : nearestLinkPath();
          if (!filePath || !existsSync(filePath)) {
            throw usageError("No project link found.");
          }
          removeProjectLinkFile(filePath);
          writeResult(
            { status: "removed", path: filePath },
            globalOptions.format
          );
          return;
        }

        const selector = resolveProjectSelector({
          flagProject: project,
          ignoreLink: true,
          emptyFlagMessage:
            "Project argument cannot be empty. Omit it to use MCPJAM_PROJECT or automatic selection.",
        });

        const result = await runPlatformOperation(
          platform,
          globalOptions.timeout,
          async ({ client, signal, baseUrl }) => {
            const page = await client.listProjects({}, { signal });
            const resolution = resolveProject(page.items, selector.selector);
            if (!resolution.ok) {
              throw projectResolutionError(resolution.message);
            }
            const chosen = resolution.project;
            const directory = projectLinkWriteDir({
              here: options.here === true,
            });
            const link: ProjectLink = {
              version: 1,
              project: { id: chosen.id, name: chosen.name },
              ...(chosen.organizationId
                ? { organizationId: chosen.organizationId }
                : {}),
              apiUrl: baseUrl,
            };
            const pathWritten = await writeProjectLink({ directory, link });
            return {
              status: "linked" as const,
              path: pathWritten,
              project: { id: chosen.id, name: chosen.name },
              apiUrl: baseUrl,
            };
          },
          { announce: false }
        );

        writeResult(result, globalOptions.format);
      }
    );
}
