import { harnessDisplayName } from "./harness-model-support";

export interface HarnessCapabilityRequirements {
  builtInToolIds?: readonly string[];
  pinnedComputerImageId?: string | null;
  hasSeededAttachments?: boolean;
  browserToolPolicy?: unknown;
}

/** Composer files/images already use the session's file API in both venues.
 * Seeded eval attachments instead require a cloud computer's frozen image. */
export function localHarnessCapabilityRefusal(
  harnessId: string,
  requirements: HarnessCapabilityRequirements,
): string | undefined {
  const unsupported: string[] = [];
  if (requirements.pinnedComputerImageId)
    unsupported.push("a pinned computer image");
  if (requirements.hasSeededAttachments)
    unsupported.push("seeded eval attachments");
  if (requirements.browserToolPolicy) unsupported.push("a browser tool policy");
  const tools = requirements.builtInToolIds?.filter((id) =>
    ["bash", "browser", "computer", "desktop", "video"].includes(id),
  );
  if (tools?.length)
    unsupported.push(`cloud tools (${[...new Set(tools)].join(", ")})`);
  if (!unsupported.length) return undefined;
  return `Local ${harnessDisplayName(
    harnessId,
  )} cannot provide ${unsupported.join(
    "; ",
  )}. Choose cloud execution or remove these capabilities. Native file and command tools remain available locally.`;
}
