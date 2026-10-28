import type { useEnsureAdhocEnvironment } from "@/hooks/useProjectEnvironments";

type EnsureEnvironment = ReturnType<typeof useEnsureAdhocEnvironment>;

/** Older backends reject the new purpose field before executing the mutation. */
export async function ensureChatEnvironment(
  ensure: EnsureEnvironment,
  args: Parameters<EnsureEnvironment>[0],
) {
  try {
    return await ensure(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !args.purpose ||
      !/(?:extra|unexpected) field [`'\"]purpose[`'\"]/i.test(message)
    )
      throw error;
    const { purpose: _purpose, ...legacy } = args;
    return await ensure(legacy);
  }
}
