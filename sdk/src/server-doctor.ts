import { probeMcpServer } from "./server-probe.js";
import { withSkillsExtensionCapability } from "./mcp-client-manager/index.js";
import {
  getVerifiedServerSkill,
  isServerSkillRefusalError,
  listServerSkillCatalog,
} from "./server-skills.js";
import {
  listAllPrompts,
  listAllResourceTemplates,
  listAllResources,
  listAllTools,
  withEphemeralClient,
} from "./operations.js";
import type {
  MCPClientManager,
  MCPServerConfig,
  RetryPolicy,
  RpcLogger,
} from "./mcp-client-manager/index.js";
import {
  applyConnectedServerDoctorState,
  buildConnectedServerDoctorState,
  buildDoctorProbeConfig,
  createServerDoctorResult,
  deriveDoctorStatus,
  describeCount,
  errorCheck,
  hasConnectionCredentials,
  normalizeServerDoctorError,
  okCheck,
  skippedCheck,
  summarizeProbeCheck,
} from "./server-doctor-core.js";
import type {
  ConnectedServerDoctorState,
  DoctorPromptsCollectionResult,
  DoctorResourceTemplatesCollectionResult,
  DoctorResourcesCollectionResult,
  DoctorSkillsCollectionResult,
  DoctorToolsCollectionResult,
  ServerDoctorResult,
} from "./server-doctor-core.js";

export { normalizeServerDoctorError } from "./server-doctor-core.js";
export type {
  ConnectedServerDoctorState,
  ServerDoctorCheck,
  ServerDoctorChecks,
  ServerDoctorConnection,
  ServerDoctorError,
  ServerDoctorResult,
} from "./server-doctor-core.js";

export interface RunServerDoctorInput<TTarget = unknown> {
  config: MCPServerConfig;
  target: TTarget;
  timeout: number;
  rpcLogger?: RpcLogger;
  retryPolicy?: RetryPolicy;
  /** Transport for the probe's requests. See `buildDoctorProbeConfig`. */
  fetchFn?: typeof fetch;
}

type WithConnectedManager = <T>(
  config: MCPServerConfig,
  fn: (manager: MCPClientManager, serverId: string) => Promise<T>,
  options?: {
    timeout?: number;
    rpcLogger?: RpcLogger;
    retryPolicy?: RetryPolicy;
  }
) => Promise<T>;

export interface ServerDoctorDependencies {
  probeServer?: typeof probeMcpServer;
  withManager?: WithConnectedManager;
}

export async function runServerDoctor<TTarget = unknown>(
  input: RunServerDoctorInput<TTarget>,
  dependencies: ServerDoctorDependencies = {}
): Promise<ServerDoctorResult<TTarget>> {
  const probeServer = dependencies.probeServer ?? probeMcpServer;
  const withManager =
    dependencies.withManager ??
    ((config, fn, options) =>
      withEphemeralClient(config, fn, {
        timeout: options?.timeout,
        rpcLogger: options?.rpcLogger,
        retryPolicy: options?.retryPolicy,
        serverId: "__cli__",
        clientName: "mcpjam",
      }));
  const result = createServerDoctorResult(input.target, {
    probeDetail:
      "url" in input.config
        ? "HTTP probe did not run."
        : "HTTP probe not applicable for stdio targets.",
  });

  if ("url" in input.config) {
    const probeUrl = input.config.url;
    if (!probeUrl) {
      throw new Error("HTTP doctor flow requires a server URL.");
    }

    try {
      result.probe = await probeServer(
        buildDoctorProbeConfig(input.config, {
          timeout: input.timeout,
          retryPolicy: input.retryPolicy,
          fetchFn: input.fetchFn,
        })
      );
      result.checks.probe = summarizeProbeCheck(
        result.probe,
        hasConnectionCredentials(input.config, {
          includeAuthProvider: false,
        })
      );
    } catch (error) {
      const structured = normalizeServerDoctorError(error);
      result.checks.probe = errorCheck(
        `HTTP probe failed: ${structured.message}`
      );
      result.error = structured;
    }

    if (
      result.probe?.status === "oauth_required" &&
      !hasConnectionCredentials(input.config)
    ) {
      result.status = "oauth_required";
      result.connection = {
        status: "skipped",
        detail: "Server requires OAuth before a connection can be established.",
      };
      result.checks.connection = skippedCheck(result.connection.detail);
      result.error = {
        code: "OAUTH_REQUIRED",
        message:
          "Server requires OAuth before it can be connected. Run an OAuth login flow first.",
        details: {
          registrationStrategies: result.probe.oauth.registrationStrategies,
          authorizationServerMetadataUrl:
            result.probe.oauth.authorizationServerMetadataUrl,
          resourceMetadataUrl: result.probe.oauth.resourceMetadataUrl,
        },
      };
      return result;
    }
  }

  try {
    const collected = await withManager(
      // Declare the skills extension for this connection, or `skills/*` is
      // correctly refused and the doctor could only ever report `skipped` —
      // it would be reporting its own omission as a fact about the server.
      // Merged into the legacy capabilities bag, so a caller that pinned an
      // exact `clientCapabilities` set still wins and still gets an honest
      // `skipped`.
      {
        ...input.config,
        capabilities: withSkillsExtensionCapability(
          (input.config as { capabilities?: Record<string, unknown> })
            .capabilities ?? {}
        ),
      },
      (manager, serverId) =>
        collectConnectedServerDoctorState(manager, serverId),
      {
        timeout: input.timeout,
        rpcLogger: input.rpcLogger,
        retryPolicy: input.retryPolicy,
      }
    );

    applyConnectedServerDoctorState(result, collected);
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    result.connection = {
      status: "error",
      detail: structured.message,
    };
    result.checks.connection = errorCheck(structured.message);
    result.error = structured;
  }

  result.status = deriveDoctorStatus(result);
  if (result.status === "ready") {
    result.error = null;
  }

  return result;
}

export async function collectConnectedServerDoctorState(
  manager: MCPClientManager,
  serverId: string
): Promise<ConnectedServerDoctorState> {
  const initInfo = manager.getInitializationInfo(serverId) ?? null;
  const capabilities = manager.getServerCapabilities(serverId) ?? null;

  const [
    toolsResult,
    resourcesResult,
    promptsResult,
    resourceTemplatesResult,
    skillsResult,
  ] = await Promise.all([
    collectTools(manager, serverId),
    collectResources(manager, serverId),
    collectPrompts(manager, serverId),
    collectResourceTemplates(manager, serverId),
    collectSkills(manager, serverId),
  ]);

  return buildConnectedServerDoctorState({
    initInfo,
    capabilities,
    toolsResult,
    resourcesResult,
    promptsResult,
    resourceTemplatesResult,
    skillsResult,
  });
}

/**
 * How many skills the doctor actually FETCHES.
 *
 * Every other doctor check lists; this one verifies, and verification costs a
 * `resources/read` per skill. A server with 200 skills should not turn
 * `mcpjam server doctor` into a bulk download, and a manifest that disagrees
 * with its bytes is almost never wrong for one skill alone — a sample answers
 * "does this server's skill serving work" without pretending to be an audit.
 */
const DOCTOR_SKILL_VERIFY_SAMPLE = 5;

/**
 * Why `skills/*` was not attempted, attributed to whoever actually withheld the
 * declaration.
 *
 * `active` is the AND of two independent declarations, so one message covering
 * both sides reports OUR omission as a fact about the server. That matters more
 * here than it looks: `runServerDoctor` now advertises the extension itself, so
 * the only way to reach `declared && !advertised` is a caller that pinned an
 * exact client-capability set — `--host cursor` and friends. That caller is
 * asking "what would this host see", and the honest answer is that the host, not
 * the server, is the reason there is nothing to see. The CLI's `skills` verbs
 * already refuse that case by name (`applySkillsExtensionCapability`); a doctor
 * that blamed the server would contradict them on the same connection.
 *
 * Status stays `skipped` in every branch. A host pin is a legitimate way to run
 * the doctor, not a defect in the server being examined.
 */
function inactiveSkillsDetail(
  support: { declared?: boolean; advertised?: boolean } | undefined
): string {
  if (support?.declared && !support.advertised) {
    return (
      "This server DOES declare Skills over MCP, but the client capabilities " +
      "pinned for this run did not advertise the extension, so no `skills/*` " +
      "call was made. Drop the host/capability pin to inspect them."
    );
  }
  if (support && !support.declared) {
    return "The server does not declare the Skills over MCP extension (`io.modelcontextprotocol/skills`).";
  }
  // `getSkillsSupport` threw — we know nothing about either side, so the
  // original both-sides wording is the only honest one left.
  return "Skills over MCP is not active on this connection (the server must declare the extension and the client must advertise it).";
}

/**
 * Skills over MCP (SEP-2640), verified rather than counted.
 *
 * Three outcomes, deliberately distinct:
 *   - extension inactive -> `skipped`, because most servers serve no skills and
 *     that is not a fault. Which SIDE withheld it is named — see
 *     {@link inactiveSkillsDetail};
 *   - listing works and the sample verifies -> `ok`;
 *   - a skill fails verification -> `error` naming the refusal KIND, since
 *     `digest_mismatch` and `frontmatter_drift` send a server author to
 *     completely different code.
 *
 * A skill the server itself marks unloadable (`dynamic`, no manifest, over the
 * SEP's per-skill limits) is reported but is NOT an error: the server is
 * telling the truth about what it serves.
 */
async function collectSkills(
  manager: MCPClientManager,
  serverId: string
): Promise<DoctorSkillsCollectionResult> {
  let support:
    | { active?: boolean; declared?: boolean; advertised?: boolean }
    | undefined;
  try {
    support = manager.getSkillsSupport(serverId);
  } catch {
    support = undefined;
  }
  if (!support?.active) {
    return { skills: [], check: skippedCheck(inactiveSkillsDetail(support)) };
  }

  try {
    const listing = await listServerSkillCatalog(manager, serverId);
    const sample = listing.skills
      .filter((skill) => !skill.unloadable)
      .slice(0, DOCTOR_SKILL_VERIFY_SAMPLE);

    const failures: string[] = [];
    for (const skill of sample) {
      try {
        await getVerifiedServerSkill(manager, {
          serverId,
          uri: skill.skillUri,
        });
      } catch (error) {
        if (isServerSkillRefusalError(error)) {
          failures.push(`${skill.skillUri} (${error.refusal.kind})`);
        } else {
          throw error;
        }
      }
    }

    const unloadable = listing.skills.filter((skill) => skill.unloadable).length;
    const loadable = listing.skills.length - unloadable;
    const parts = [describeCount(listing.skills.length, "skill")];
    if (sample.length > 0) {
      // Name the cap when it bit. "200 skills discovered. 5 verified" reads as
      // "only 5 of them could be verified", which is a much worse claim than
      // the true one — that the doctor deliberately stopped at 5.
      const scope =
        loadable > sample.length
          ? `${sample.length} of ${loadable} sampled and verified`
          : `${sample.length} verified`;
      parts.push(
        `${scope} against ${sample.length === 1 ? "its manifest" : "their manifests"}.`
      );
    }
    if (unloadable > 0) {
      parts.push(
        `${unloadable} advertised but not loadable (the server says so itself).`
      );
    }
    // A REJECTED entry is a defect, unlike an unloadable one. `unloadable`
    // means the server told the truth about something it cannot serve
    // verifiably (dynamic content, or a manifest past the SEP's per-skill
    // limits). `rejected` means MCPJam could not make sense of the manifest at
    // all — a missing digest, a URI listed twice, an entry pointing outside the
    // skill's own directory. Reporting that as `ok` because the sample happened
    // to verify would tell an author their skills serving is fine while a
    // conforming host is dropping entries on the floor.
    const problems: string[] = [];
    if (failures.length > 0) {
      problems.push(
        `${failures.length} of ${sample.length} sampled skills failed verification: ${failures.join(", ")}`
      );
    }
    if (listing.rejected.length > 0) {
      problems.push(
        `${listing.rejected.length} listed ${listing.rejected.length === 1 ? "entry" : "entries"} rejected as malformed: ${listing.rejected
          .map((entry) => `${entry.skillUri} (${entry.reason})`)
          .join(", ")}`
      );
    }
    if (problems.length > 0) {
      return {
        skills: listing.skills,
        check: errorCheck(`${problems.join("; ")}.`),
      };
    }
    return { skills: listing.skills, check: okCheck(parts.join(" ")) };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      skills: [],
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}

async function collectTools(
  manager: MCPClientManager,
  serverId: string
): Promise<DoctorToolsCollectionResult> {
  try {
    // Raw-evidence surface: bypass the SEP-2549 response cache so the doctor
    // reports the server's live surface, never a cached body.
    const result = await listAllTools(manager, { serverId, cacheMode: "bypass" });
    const tools =
      result.tools?.map((tool) => {
        const { _meta: _ignoredMeta, ...toolWithoutMeta } = tool;
        return toolWithoutMeta;
      }) ?? [];
    return {
      tools,
      toolsMetadata: result.toolsMetadata,
      check: okCheck(describeCount(tools.length, "tool")),
    };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      tools: [],
      toolsMetadata: {},
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}

async function collectResources(
  manager: MCPClientManager,
  serverId: string
): Promise<DoctorResourcesCollectionResult> {
  try {
    const result = await listAllResources(manager, {
      serverId,
      cacheMode: "bypass",
    });
    const resources = result.resources ?? [];
    return {
      resources,
      check: okCheck(describeCount(resources.length, "resource")),
    };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      resources: [],
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}

async function collectPrompts(
  manager: MCPClientManager,
  serverId: string
): Promise<DoctorPromptsCollectionResult> {
  try {
    const result = await listAllPrompts(manager, {
      serverId,
      cacheMode: "bypass",
    });
    const prompts = result.prompts ?? [];
    return {
      prompts,
      check: okCheck(describeCount(prompts.length, "prompt")),
    };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      prompts: [],
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}

async function collectResourceTemplates(
  manager: MCPClientManager,
  serverId: string
): Promise<DoctorResourceTemplatesCollectionResult> {
  try {
    const result = await listAllResourceTemplates(manager, {
      serverId,
      cacheMode: "bypass",
    });
    const resourceTemplates = result.resourceTemplates ?? [];
    if (result.unsupported) {
      return {
        resourceTemplates,
        check: skippedCheck("Server does not support resources/templates."),
      };
    }
    return {
      resourceTemplates,
      check: okCheck(
        describeCount(resourceTemplates.length, "resource template")
      ),
    };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      resourceTemplates: [],
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}
