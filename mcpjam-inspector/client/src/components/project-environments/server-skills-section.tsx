/**
 * The "From MCP servers" section of the environment skills picker: captured
 * MCP-server skills (SEP-2640), each with the server it came from and a
 * version control, like a Library row.
 *
 * An environment accepts a server skill only while its server group holds
 * that skill's server (the backend checks again on every write), so the
 * section offers skills from the servers every environment's group holds.
 * A skill some environment already selects is listed either way, so it can
 * be removed.
 */
import { useState } from "react";
import { Server } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Badge } from "@mcpjam/design-system/badge";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import type { ProjectEnvironmentServerSkillSelection } from "@/hooks/useProjectEnvironments";
import {
  useProjectServerSkills,
  useServerSkillVersions,
  type ProjectServerSkill,
} from "@/hooks/use-server-skills";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { cn } from "@/lib/utils";
import type {
  SkillSelectionAcross,
  SkillSelectionEdit,
} from "./ProjectEnvironmentSkillsPicker";
import { RemoveEverywhere, SkillVersionSelect } from "./skill-row-controls";

/** What a picker that offers server skills needs from its caller. */
export type ServerSkillsChoice = {
  /** Server skills every environment selects, at the version they share. */
  value: ProjectEnvironmentServerSkillSelection | null;
  across: SkillSelectionAcross;
  /** The edit's `skillId` is the server skill's id. */
  onChange: (edit: SkillSelectionEdit) => void;
  /** Each environment's server group. */
  serverAttachmentIds: readonly (string | null)[];
};

/** The servers every group holds; `null` while the groups load. */
function useServersInEveryGroup(
  projectId: string,
  groups: readonly (string | null)[],
): ReadonlySet<string> | null {
  const { isAuthenticated } = useConvexAuth();
  const { serverAttachments, isLoading } = useProjectServerAttachments({
    isAuthenticated,
    projectId,
  });
  if (isLoading) return null;
  const [first, ...others] = groups.map(
    (id) => new Set(serverAttachments.find((row) => row._id === id)?.serverIds),
  );
  return new Set(
    [...(first ?? [])].filter((serverId) =>
      others.every((servers) => servers.has(serverId)),
    ),
  );
}

/** Why an environment can't select this skill, or `null` when it can. */
function blockedReason(
  skill: ProjectServerSkill,
  inEveryGroup: boolean,
): string | null {
  if (skill.unpinnable?.reason === "no_resources") {
    return "Its server lists no files for this skill, so MCPJam can’t verify it. Update the server to list them.";
  }
  if (skill.unpinnable?.reason === "files_over_cap") {
    return "This skill has more files than MCPJam captures, so runs can’t use it. Remove some files on the server.";
  }
  if (skill.unpinnable) {
    return "Runs can’t use this skill. Open it in the Skills tab to see why.";
  }
  if (!inEveryGroup) {
    return "Its server isn’t in every client’s server group. Add the server to the group to use this skill.";
  }
  return null;
}

export function ServerSkillsSection({
  projectId,
  choice,
  disabled,
}: {
  projectId: string;
  choice: ServerSkillsChoice;
  disabled: boolean;
}) {
  const skills = useProjectServerSkills(projectId);
  const served = useServersInEveryGroup(projectId, choice.serverAttachmentIds);
  if (!skills || !served) return null;
  const selectedIds = new Set(choice.value?.serverSkillIds ?? []);
  const pins = new Map(
    (choice.value?.versionPins ?? []).map((pin) => [
      pin.serverSkillId,
      pin.versionId,
    ]),
  );
  const rows = skills.filter(
    (skill) =>
      served.has(skill.serverId) ||
      selectedIds.has(skill.id) ||
      choice.across.partialIds.has(skill.id),
  );
  if (!rows.length) return null;
  return (
    <>
      <div className="px-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        From MCP servers
      </div>
      {rows.map((skill) => {
        const checked = selectedIds.has(skill.id);
        const partial = !checked && choice.across.partialIds.has(skill.id);
        const reason = blockedReason(skill, served.has(skill.serverId));
        const capBlocked = !checked && !choice.across.canAdd(skill.id);
        // Partly on but can't be turned on: only its own button removes it.
        const removeOnly = partial && (reason !== null || capBlocked);
        const rowDisabled =
          disabled ||
          (!removeOnly && (capBlocked || (reason !== null && !checked)));
        const remove = () =>
          choice.onChange({ kind: "remove", skillId: skill.id });
        return (
          <Label
            key={skill.id}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/30",
              rowDisabled &&
                "cursor-not-allowed opacity-60 hover:bg-transparent",
            )}
          >
            <Checkbox
              checked={partial ? "indeterminate" : checked}
              onCheckedChange={(next) =>
                next === true
                  ? choice.onChange({ kind: "add", skillId: skill.id })
                  : remove()
              }
              disabled={rowDisabled || removeOnly}
              aria-label={skill.ref}
            />
            <Server className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-normal">{skill.name}</span>
                <Badge
                  variant="secondary"
                  className="px-1.5 py-0 text-[10px] font-normal"
                >
                  {skill.serverSlug}
                </Badge>
              </span>
              {reason ? (
                <span className="text-[11px] leading-snug text-muted-foreground">
                  {reason}
                </span>
              ) : skill.description ? (
                <span className="truncate text-[11px] text-muted-foreground">
                  {skill.description}
                </span>
              ) : null}
              {removeOnly ? (
                <RemoveEverywhere disabled={disabled} onRemove={remove} />
              ) : null}
            </span>
            {checked ? (
              <ServerSkillVersionControl
                skill={skill}
                pinnedVersionId={pins.get(skill.id) ?? null}
                // A selection the backend refuses leads nowhere; removing
                // it is the only repair.
                disabled={disabled || reason !== null}
                onChange={(versionId) =>
                  choice.onChange({ kind: "pin", skillId: skill.id, versionId })
                }
              />
            ) : null}
          </Label>
        );
      })}
    </>
  );
}

function ServerSkillVersionControl({
  skill,
  pinnedVersionId,
  disabled,
  onChange,
}: {
  skill: ProjectServerSkill;
  pinnedVersionId: string | null;
  disabled: boolean;
  onChange: (versionId: string | null) => void;
}) {
  const [opened, setOpened] = useState(false);
  // A pin reads its history at once, so the menu names its version.
  const versions = useServerSkillVersions(
    skill.id,
    opened || pinnedVersionId !== null,
  );
  return (
    <SkillVersionSelect
      label={`Version for ${skill.ref}`}
      latestLabel={`Latest (v${skill.versionNumber})`}
      versions={
        versions?.map((version) => ({
          id: version.id,
          label: `v${version.versionNumber}${
            version.id === skill.versionId ? " (current)" : ""
          }`,
        })) ?? null
      }
      loading={opened && versions === undefined}
      pinnedVersionId={pinnedVersionId}
      disabled={disabled}
      onOpen={() => setOpened(true)}
      onChange={onChange}
    />
  );
}
