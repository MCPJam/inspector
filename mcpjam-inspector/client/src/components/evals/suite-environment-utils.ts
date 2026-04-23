export type WorkspaceServerRecord = {
  _id: string;
  name: string;
  transportType?: "stdio" | "http";
};

export type SuiteEnvironmentOption = {
  name: string;
  workspaceServerId?: string;
  isConfigured: boolean;
  isInWorkspace: boolean;
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
        workspaceServerId?: string;
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
            ...(binding.workspaceServerId
              ? { workspaceServerId: binding.workspaceServerId }
              : {}),
          },
        ]
      : [],
  );
}

export function buildSuiteEnvironmentOptions(args: {
  configuredServers: readonly string[] | undefined;
  workspaceServers: readonly WorkspaceServerRecord[] | undefined;
  connectedServerNames: ReadonlySet<string>;
}): SuiteEnvironmentOption[] {
  const configured = normalizeServerNames(args.configuredServers);
  const workspaceServers = args.workspaceServers ?? [];
  const workspaceServerByName = new Map(
    workspaceServers.map((server) => [server.name.toLowerCase(), server]),
  );

  const options: SuiteEnvironmentOption[] = [];
  const seen = new Set<string>();

  for (const serverName of configured) {
    const key = serverName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const workspaceServer = workspaceServerByName.get(key);
    options.push({
      name: serverName,
      workspaceServerId: workspaceServer?._id,
      isConfigured: true,
      isInWorkspace: Boolean(workspaceServer),
      isConnected: args.connectedServerNames.has(serverName),
    });
  }

  const remainingWorkspaceServers = [...workspaceServers].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const workspaceServer of remainingWorkspaceServers) {
    const key = workspaceServer.name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({
      name: workspaceServer.name,
      workspaceServerId: workspaceServer._id,
      isConfigured: false,
      isInWorkspace: true,
      isConnected: args.connectedServerNames.has(workspaceServer.name),
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
