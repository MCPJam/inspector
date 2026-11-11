/**
 * The Skills field in a suite's "Where it runs" row, and the hint lines under
 * its client table. Both read the suite's environments, which own their
 * skills: the field saves through the same derivation as the Servers pick,
 * and the hints read one skills preview per environment. Both stay hidden
 * without `skills-enabled`, the one flag every skills surface reads.
 */
import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { SkillsPill } from "@/components/environment-composer/skills-pill";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import { fetchSkillsPreview } from "@/lib/apis/web/skills-preview-api";
import type { PaneSkillsPreview } from "@/shared/pane-skills-preview";
import {
  SKILLS_READ_ONLY_REASON,
  editedSkillSelection,
  skillDeliveryLines,
  suiteSkillState,
  type SuiteSkillsEdit,
} from "./suite-skills";

export function SuiteSkillsField({
  projectId,
  environments,
  disabled,
  editable,
  onEdit,
}: {
  projectId: string;
  environments: readonly ProjectEnvironmentView[];
  disabled: boolean;
  /** False when the backend can't derive from the stored environment. */
  editable: boolean;
  onEdit: (skills: SuiteSkillsEdit) => void;
}) {
  const skillsEnabled = useSkillsEnabled();
  if (!skillsEnabled) return null;
  const { value, across } = suiteSkillState(environments);
  return (
    <div className="flex min-w-[15rem] max-w-sm flex-1 items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Skills</span>
      <div className="min-w-0 flex-1">
        <SkillsPill
          variant="field"
          projectId={projectId}
          value={value}
          across={across}
          readOnly={!editable}
          notice={
            !editable
              ? SKILLS_READ_ONLY_REASON
              : across.partialIds.size
                ? "Checking a skill here sets it at Latest on every client, and clearing one removes it from every client."
                : undefined
          }
          // With no client yet there is no environment to hold a skill.
          disabled={disabled || environments.length === 0}
          testId="suite-clients-skills"
          onChange={(_next, edit) =>
            onEdit((row) => editedSkillSelection(row.skillSelection, edit))
          }
        />
      </div>
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
): Delivery {
  const key =
    projectId && environments.length
      ? JSON.stringify([
          projectId,
          environments.map((row) => [row.environmentId, row.revision]),
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
        if (controller.signal.aborted) return;
        setResult({
          key,
          previews: new Map(ids.map((id, index) => [id, previews[index]!])),
        });
      },
      () => {
        if (!controller.signal.aborted) setResult({ key, previews: null });
      },
    );
    return () => controller.abort();
    // `key` stands for the environments: same ids and revisions, same answer.
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
  hostName,
}: {
  projectId: string;
  /** The suite's attached environments, all resolved. */
  environments: readonly ProjectEnvironmentView[];
  hostName: (hostId: string) => string;
}) {
  const skillsEnabled = useSkillsEnabled();
  const delivery = useSuiteSkillDelivery(
    skillsEnabled ? projectId : null,
    environments,
  );
  if (!skillsEnabled) return null;
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
  const mixed = suiteSkillState(environments).across.partialIds.size > 0;
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
          <p role="status">Couldn’t check which clients load these skills.</p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={delivery.retry}
          >
            Try again
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
