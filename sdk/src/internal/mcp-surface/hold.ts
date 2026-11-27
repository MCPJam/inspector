import {
  connectEvalCheckRepoOperation,
  connectEvalGithubRepoOperation,
  driveChatSessionBrowserOperation,
  getEvalDescriptionExperimentOperation,
  getImageOperation,
  getPluginVersionOperation,
  getProjectSkillOperation,
  getRegistryDirectoryServerOperation,
  installRegistryDirectoryServerOperation,
  listEvalCheckReposOperation,
  listEvalGithubReposOperation,
  listImagesOperation,
  listProjectPluginsOperation,
  listProjectSkillsOperation,
  listRegistryDirectorySourcesOperation,
  observeChatSessionBrowserOperation,
  proposeEvalDescriptionRewriteOperation,
  searchRegistryDirectoryOperation,
  searchSessionsOperation,
  setEvalSuiteScheduleOperation,
  startEvalDescriptionExperimentOperation,
} from "../../platform/index.js";

/**
 * Catalog tools HELD off this surface while their feature is in beta.
 *
 * This catalog is one static list, built with no caller in hand, so it cannot
 * offer a beta only to the organizations that have it. Advertising these to
 * everyone would offer most callers tools they cannot use, so they are
 * withheld from everyone instead, until the tool list is resolved per caller.
 * REST, the SDK and the CLI are unaffected.
 *
 * Each held operation keeps its place, and its rationale, in the hosted
 * server's `CATALOG_OPERATIONS_INCLUDING_HELD`; its `PLATFORM_CATALOG_OPERATIONS`
 * filters it out and `EXCLUDED_FROM_CATALOG` gives the reason. Any other MCP
 * server that lists catalog tools holds the same ones. Releasing a feature is
 * deleting its entry here.
 */
export const HELD_WHILE_IN_BETA: ReadonlyArray<{
  feature: string;
  // Only the names are read, so any operation fits.
  operations: ReadonlyArray<{ readonly name: string }>;
}> = [
  { feature: "unified sessions", operations: [searchSessionsOperation] },
  {
    feature: "the registry directory",
    operations: [
      searchRegistryDirectoryOperation,
      getRegistryDirectoryServerOperation,
      listRegistryDirectorySourcesOperation,
      installRegistryDirectoryServerOperation,
    ],
  },
  {
    feature: "the hosted browser",
    operations: [
      driveChatSessionBrowserOperation,
      observeChatSessionBrowserOperation,
    ],
  },
  {
    feature: "Cloud Skills",
    operations: [listProjectSkillsOperation, getProjectSkillOperation],
  },
  {
    feature: "Computers",
    operations: [listImagesOperation, getImageOperation],
  },
  {
    feature: "Agent Plugins",
    operations: [listProjectPluginsOperation, getPluginVersionOperation],
  },
  {
    feature: "GitHub checks",
    operations: [
      listEvalGithubReposOperation,
      connectEvalGithubRepoOperation,
      listEvalCheckReposOperation,
      connectEvalCheckRepoOperation,
    ],
  },
  {
    feature: "description experiments",
    operations: [
      proposeEvalDescriptionRewriteOperation,
      startEvalDescriptionExperimentOperation,
      getEvalDescriptionExperimentOperation,
    ],
  },
  { feature: "scheduled runs", operations: [setEvalSuiteScheduleOperation] },
];

export const HELD_OPERATION_NAMES: ReadonlySet<string> = new Set(
  HELD_WHILE_IN_BETA.flatMap(({ operations }) =>
    operations.map((operation) => operation.name)
  )
);
