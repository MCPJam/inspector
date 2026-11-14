import { useCallback, useEffect, useState } from "react";
import { ComparePaneSettingsSection } from "./compare-pane-settings";
import type { ComparePaneSections } from "./use-compare-pane-controls";
import { Button } from "@mcpjam/design-system/button";
import {
  skillExclusionLabel,
  UNLISTED_SKILL_NOTE,
} from "@/lib/skill-delivery-labels";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import { authFetch } from "@/lib/session-token";
import type { RecoveryPane } from "@/lib/comparison-recovery-record";
import {
  paneSkillsPreview,
  type PaneSkillRow,
  type PaneSkillsPreview,
  type PaneSkillsRequest,
} from "@/shared/pane-skills-preview";

interface Props {
  /** Null when there is no signed-in project. */
  projectId: string | null;
  pane: RecoveryPane;
  namedSetupsVisible: boolean;
  /** The exact ad hoc setup used for this client's plugin selections, if any. */
  clientEnvironmentId?: string | null;
  /** The context window of the pane's model, which sizes its skill list. */
  modelContextTokens?: number;
  pending?: boolean;
}

export function ComparePaneSkills({
  projectId,
  pane,
  clientEnvironmentId,
  namedSetupsVisible,
  modelContextTokens,
  pending,
}: Props) {
  const visible = useSkillsEnabled();
  if (
    !visible ||
    !projectId ||
    (pane.target.kind === "environment" && !namedSetupsVisible)
  )
    return null;
  const request: PaneSkillsRequest = {
    projectId,
    target:
      pane.target.kind === "environment"
        ? pane.target
        : {
            kind: "client",
            hostId: pane.target.hostId,
            environmentId: clientEnvironmentId ?? undefined,
          },
    serverIds: pane.serverIds ?? undefined,
    pluginVersionIds: pane.pluginVersionIds ?? undefined,
    modelContextTokens,
  };
  const body = JSON.stringify(request);
  return (
    <ComparePaneSettingsSection title="Skills">
      {pending ? <LoadingSkills /> : <DeliveryList key={body} body={body} />}
    </ComparePaneSettingsSection>
  );
}

function LoadingSkills() {
  return (
    <p role="status" className="text-xs text-muted-foreground">
      Loading skills…
    </p>
  );
}

function DeliveryList({ body }: { body: string }) {
  const [result, setResult] = useState<PaneSkillsPreview | "failed" | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function read() {
      const response = await authFetch("/api/web/environments/skills-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      const data = response.ok
        ? paneSkillsPreview.parse(await response.json())
        : "failed";
      if (!controller.signal.aborted) setResult(data);
    }
    void read().catch(() => {
      if (!controller.signal.aborted) setResult("failed");
    });
    return () => controller.abort();
  }, [attempt, body]);
  if (result === null) return <LoadingSkills />;
  if (result === "failed") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span role="status" className="text-xs text-muted-foreground">
          Skills didn’t load. Try again.
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setResult(null);
            setAttempt((current) => current + 1);
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!result.skills.length)
    return (
      <p className="text-xs text-muted-foreground">No skills for this pane.</p>
    );
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {result.deliveredCount === 1
          ? "1 skill available"
          : `${result.deliveredCount} skills available`}
      </p>
      <ul className="max-h-44 space-y-2 overflow-y-auto">
        {result.skills.map((skill) => (
          <li key={skill.skillId} className="space-y-0.5">
            <span className="block break-words text-sm">{skill.name}</span>
            <SkillNote skill={skill} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** The line under a skill: why the pane's turns leave it out, that the model
 *  won't see it listed, or else what it does. */
function SkillNote({ skill }: { skill: PaneSkillRow }) {
  const server =
    skill.origin?.kind === "mcp-server" ? skill.origin.server : undefined;
  const note = skill.reason
    ? skillExclusionLabel(skill.reason, { server })
    : skill.omittedFromCatalog
      ? UNLISTED_SKILL_NOTE
      : skill.description;
  if (!note) return null;
  return <p className="break-words text-xs text-muted-foreground">{note}</p>;
}

export function useComparePaneSkillsSection(
  projectId: string | null,
  namedSetupsVisible: boolean,
): ComparePaneSections {
  return useCallback(
    ({ pane, lane, model }) => (
      <ComparePaneSkills
        projectId={projectId}
        pane={pane}
        namedSetupsVisible={namedSetupsVisible}
        clientEnvironmentId={lane.environmentId}
        modelContextTokens={contextTokens(model?.contextLength)}
        pending={lane.pending}
      />
    ),
    [projectId, namedSetupsVisible],
  );
}

/** A context size the preview can send. A turn reads any other value as an
 *  unknown size, as the preview does when the field is absent. */
function contextTokens(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
