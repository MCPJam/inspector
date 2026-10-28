import { resolvePlaygroundCredentialEnvironment } from "../../utils/harness/playground-box.js";

type Result =
  | { ok: true; environmentId?: string }
  | Extract<
      Awaited<ReturnType<typeof resolvePlaygroundCredentialEnvironment>>,
      { ok: false }
    >;

/** A composed trace identity must not replace an existing conversation's sandbox grant. */
export async function resolveApiHarnessEnvironment(args: {
  projectId: string;
  bearer: string;
  harnessId: string;
  hostId?: string;
  pinnedEnvironmentId?: string;
  resolvedEnvironmentId?: string;
  credential: boolean;
}): Promise<Result> {
  const environmentId =
    args.pinnedEnvironmentId ??
    (args.credential ? args.resolvedEnvironmentId : undefined);
  if (environmentId || !args.credential || !args.hostId)
    return { ok: true, environmentId };
  // Older backends leave credential composition to this adapter.
  return resolvePlaygroundCredentialEnvironment({
    projectId: args.projectId,
    hostId: args.hostId,
    bearer: args.bearer,
    harnessId: args.harnessId,
  });
}
