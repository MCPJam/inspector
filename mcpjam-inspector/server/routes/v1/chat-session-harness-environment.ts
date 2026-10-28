/** A composed trace identity must not replace an existing conversation's sandbox grant. */
export function resolveApiHarnessEnvironment(args: {
  pinnedEnvironmentId?: string;
  resolvedEnvironmentId?: string;
  credential: boolean;
}):
  | { ok: true; environmentId?: string }
  | { ok: false; status: 409; message: string } {
  const environmentId =
    args.pinnedEnvironmentId ??
    (args.credential ? args.resolvedEnvironmentId : undefined);
  if (args.credential && !environmentId)
    return {
      ok: false,
      status: 409,
      message: "This client's credential setup is unavailable.",
    };
  return { ok: true, environmentId };
}
