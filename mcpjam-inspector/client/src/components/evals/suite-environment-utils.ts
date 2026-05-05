export type ProjectServerRecord = {
  _id: string;
  name: string;
  transportType?: "stdio" | "http";
};

export type SuiteEnvironmentOption = {
  name: string;
  projectServerId?: string;
  isConfigured: boolean;
  isInProject: boolean;
  isConnected: boolean;
};

export function normalizeServerNames(
  serverNames: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const serverName of serverNames ?? []) {
    if (typeof serverName !== "string") {
      continue;
    }
    const trimmed = serverName.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized;
}

export function filterServerBindings(
  bindings:
    | Array<{
        serverName: string;
        projectServerId?: string;
      }>
    | undefined,
  selectedServers: readonly string[],
) {
  const selected = new Set(selectedServers.map((server) => server.toLowerCase()));

  return (bindings ?? []).flatMap((binding) =>
    selected.has(binding.serverName.toLowerCase())
      ? [
          {
            serverName: binding.serverName,
            ...(binding.projectServerId
              ? { projectServerId: binding.projectServerId }
              : {}),
          },
        ]
      : [],
  );
}

export function buildSuiteEnvironmentOptions(args: {
  configuredServers: readonly string[] | undefined;
  projectServers: readonly ProjectServerRecord[] | undefined;
  connectedServerNames: ReadonlySet<string>;
}): SuiteEnvironmentOption[] {
  const configured = normalizeServerNames(args.configuredServers);
  const projectServers = args.projectServers ?? [];
  const projectServerByName = new Map(
    projectServers.map((server) => [server.name.toLowerCase(), server]),
  );

  const options: SuiteEnvironmentOption[] = [];
  const seen = new Set<string>();

  for (const serverName of configured) {
    const key = serverName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const projectServer = projectServerByName.get(key);
    options.push({
      name: serverName,
      projectServerId: projectServer?._id,
      isConfigured: true,
      isInProject: Boolean(projectServer),
      isConnected: args.connectedServerNames.has(serverName),
    });
  }

  const remainingProjectServers = [...projectServers].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const projectServer of remainingProjectServers) {
    const key = projectServer.name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({
      name: projectServer.name,
      projectServerId: projectServer._id,
      isConfigured: false,
      isInProject: true,
      isConnected: args.connectedServerNames.has(projectServer.name),
    });
  }

  return options;
}

export function buildServerBasedSuiteName(
  serverNames: readonly string[] | undefined,
  fallback = "New eval suite",
): string {
  const normalized = normalizeServerNames(serverNames);
  if (normalized.length === 0) {
    return fallback;
  }
  if (normalized.length === 1) {
    return normalized[0]!;
  }
  return `${normalized[0]} + ${normalized.length - 1} more`;
}
