/** Required servers precede optional servers; each id appears once. */
export function clientServerIds<ServerId extends string>(config: {
  serverIds?: readonly ServerId[];
  optionalServerIds?: readonly ServerId[];
}): ServerId[] {
  return [
    ...new Set([
      ...(config.serverIds ?? []),
      ...(config.optionalServerIds ?? []),
    ]),
  ];
}

export type ClientEnvironmentMatch<Environment> =
  | { kind: "none" }
  | { kind: "unique"; environment: Environment }
  | { kind: "ambiguous"; environments: Environment[] };

/** Match only the attached environments supplied by the caller. */
export function resolveClientEnvironment<Env extends { hostId?: string }>(
  clientId: string,
  attachedEnvironments: readonly Env[]
): ClientEnvironmentMatch<Env> {
  const environments = attachedEnvironments.filter(
    (environment) => environment.hostId === clientId
  );
  if (environments.length === 0) return { kind: "none" };
  if (environments.length === 1) {
    return { kind: "unique", environment: environments[0] };
  }
  return { kind: "ambiguous", environments };
}
