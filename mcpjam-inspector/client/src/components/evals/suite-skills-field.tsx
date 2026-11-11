/**
 * The Skills field in a suite's "Where it runs" row, and the hint lines under
 * its client table. Both read the suite's environments, which own their
 * skills: the field saves through the same derivation as the Servers pick,
 * and the hints read one skills preview per environment. Both stay hidden
 * without `skills-enabled`, the one flag every skills surface reads.
 */
import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { SkillsPill } from "@/components/environment-composer/skills-pill";
import type { HostListItem } from "@/hooks/useClients";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import { fetchSkillsPreview } from "@/lib/apis/web/skills-preview-api";
import type { PaneSkillsPreview } from "@/shared/pane-skills-preview";
import {
  SKILLS_READ_ONLY_REASON,
  skillDeliveryLines,
  suiteSkillState,
  type SuiteSkillsEdit,
  type SuiteSkillsSource,
} from "./suite-skills";
import {
  leftOutChange,
  libraryChange,
  scopeChange,
  scopedServerSkillCount,
  serverChange,
  serverSkillState,
  skillScopeState,
  suiteSkillsMixed,
} from "./suite-skill-channels";

export function SuiteSkillsField({
  projectId,
  environments,
  disabled,
  editable,
  scopeOffered,
  labelAbove = false,
  onEdit,
}: {
  projectId: string;
  environments: readonly SuiteSkillsSource[];
  disabled: boolean;
  /** False when the backend can't derive from the stored environment. */
  editable: boolean;
  /** The backend stores "All shared Library skills" (`allSharedLibrarySkillScope`). */
  scopeOffered: boolean;
  /** For a form whose labels sit over their fields. */
  labelAbove?: boolean;
  onEdit: (skills: SuiteSkillsEdit) => void;
}) {
  const skillsEnabled = useSkillsEnabled();
  if (!skillsEnabled) return null;
  const { value, across } = suiteSkillState(environments);
  const server = serverSkillState(environments);
  const pill = (
    <SkillsPill
      variant="field"
      projectId={projectId}
      value={value}
      across={across}
      readOnly={!editable}
      notice={
        !editable
          ? SKILLS_READ_ONLY_REASON
          : suiteSkillsMixed(environments)
            ? "Checking a skill here sets it at Latest on every client, and clearing one removes it from every client."
            : undefined
      }
      allLibrary={
        scopeOffered
          ? {
              state: skillScopeState(environments),
              serverSkillCount: scopedServerSkillCount(environments),
              onToggle: (on) => onEdit((row) => scopeChange(row, on)),
              onLeaveOut: (skillId, rest) =>
                onEdit((row) => leftOutChange(row, skillId, rest)),
            }
          : undefined
      }
      serverSkills={{
        ...server,
        serverAttachmentIds: environments.map(
          (row) => row.serverAttachmentId ?? null,
        ),
        onChange: (edit) => onEdit((row) => serverChange(row, edit)),
      }}
      // With no client yet there is no environment to hold a skill.
      disabled={disabled || environments.length === 0}
      testId="suite-clients-skills"
      onChange={(_next, edit) => onEdit((row) => libraryChange(row, edit))}
    />
  );
  return labelAbove ? (
    <div className="space-y-2">
      <Label>Skills</Label>
      <div className="max-w-sm">{pill}</div>
    </div>
  ) : (
    <div className="flex min-w-[15rem] max-w-sm flex-1 items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Skills</span>
      <div className="min-w-0 flex-1">{pill}</div>
    </div>
  );
}

type Delivery =
  | { status: "loading" }
  | { status: "failed"; retry: () => void }
  | { status: "ready"; previews: ReadonlyMap<string, PaneSkillsPreview> };

/**
 * One skills preview per environment, with the environment as the target. A
 * client target would add the caller's live project skills, personal ones
 * included, which an eval run never gets.
 */
function useSuiteSkillDelivery(
  projectId: string | null,
  environments: readonly ProjectEnvironmentView[],
  findHost: (hostId: string) => HostListItem | undefined,
): Delivery {
  // A host edit rotates its content-addressed config id but bumps no revision.
  const key =
    projectId && environments.length
      ? JSON.stringify([
          projectId,
          environments.map((row) => [
            row.environmentId,
            row.revision,
            findHost(row.hostId)?.hostConfigId,
          ]),
        ])
      : null;
  const [result, setResult] = useState<{
    key: string;
    previews: Map<string, PaneSkillsPreview> | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key || !projectId) return;
    const controller = new AbortController();
    const ids = environments.map((row) => row.environmentId);
    Promise.all(
      ids.map((environmentId) =>
        fetchSkillsPreview(
          { projectId, target: { kind: "environment", environmentId } },
          controller.signal,
        ),
      ),
    ).then(
      (previews) => {
        const map = new Map(ids.map((id, index) => [id, previews[index]!]));
        if (!controller.signal.aborted) setResult({ key, previews: map });
      },
      () => {
        if (!controller.signal.aborted) setResult({ key, previews: null });
      },
    );
    return () => controller.abort();
    // `key` stands for the environments and their hosts' configs.
  }, [key, attempt]);
  if (!key || result?.key !== key) return { status: "loading" };
  if (result.previews) return { status: "ready", previews: result.previews };
  return {
    status: "failed",
    retry: () => {
      setResult(null);
      setAttempt((current) => current + 1);
    },
  };
}

export function SuiteSkillsHints({
  projectId,
  environments,
  findHost,
}: {
  projectId: string;
  /** The suite's attached environments, all resolved. */
  environments: readonly ProjectEnvironmentView[];
  findHost: (hostId: string) => HostListItem | undefined;
}) {
  const skillsEnabled = useSkillsEnabled();
  const delivery = useSuiteSkillDelivery(
    skillsEnabled ? projectId : null,
    environments,
    findHost,
  );
  if (!skillsEnabled) return null;
  const hostName = (hostId: string) => findHost(hostId)?.name ?? "Client";
  // A client with two models gets two environments; name the model too.
  const client = (row: ProjectEnvironmentView) =>
    environments.filter((other) => other.hostId === row.hostId).length > 1
      ? `${hostName(row.hostId)} (${row.modelId ?? row.modelSelection?.modelId ?? "client model"})`
      : hostName(row.hostId);
  const lines =
    delivery.status === "ready"
      ? skillDeliveryLines(
          environments.flatMap((row) => {
            const preview = delivery.previews.get(row.environmentId);
            return preview ? [{ client: client(row), preview }] : [];
          }),
        )
      : [];
  const mixed = suiteSkillsMixed(environments);
  if (!lines.length && !mixed && delivery.status !== "failed") return null;
  return (
    <div
      className="space-y-1 text-xs text-muted-foreground"
      data-testid="suite-skills-hints"
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {delivery.status === "failed" ? (
        <div className="flex items-center gap-2">
          <p role="status">
            Couldn’t check which clients load these skills. Try again.
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={delivery.retry}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {mixed ? (
        <p data-testid="suite-skills-mixed-hint">
          These clients use different skills or versions. Checking a skill here
          sets it at Latest on every client, and clearing one removes it from
          every client.
        </p>
      ) : null}
    </div>
  );
}
