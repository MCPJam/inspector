import { useEffect, useId, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import { authFetch } from "@/lib/session-token";
import type { RecoveryPane } from "@/lib/comparison-recovery-record";
import {
  paneSkillsPreview,
  type PaneSkillRow,
  type PaneSkillsPreview,
  type PaneSkillsRequest,
} from "@/shared/pane-skills-preview";

const reasonText = {
  "unsupported-harness": "This client doesn’t support skills.",
  "server-skill-unsupported": "This client can’t use skills from MCP servers.",
  "plugin-disabled": "Its plugin is turned off for this pane.",
  "name-collision": "Another skill with this name takes precedence.",
  "invalid-skill-name": "This client can’t use this skill name.",
} satisfies Record<NonNullable<PaneSkillRow["reason"]>, string>;

interface Props {
  /** Null when there is no signed-in project. */
  projectId: string | null;
  pane: RecoveryPane;
  /** The exact ad hoc setup used for this client's plugin selections, if any. */
  clientEnvironmentId?: string | null;
  pending?: boolean;
}

export function ComparePaneSkills({
  projectId,
  pane,
  clientEnvironmentId,
  pending,
}: Props) {
  const visible = useSkillsEnabled();
  const heading = useId();
  if (!visible || !projectId) return null;
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
  };
  const body = JSON.stringify(request);
  return (
    <section aria-labelledby={heading} className="space-y-2">
      <h3 id={heading} className="text-sm font-medium">
        Skills
      </h3>
      {pending ? <LoadingSkills /> : <DeliveryList key={body} body={body} />}
    </section>
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
      if (!response.ok) throw new Error("Couldn’t load skills.");
      const data = paneSkillsPreview.parse(await response.json());
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
          Couldn’t load skills.
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
            {(skill.reason || skill.description) && (
              <p className="break-words text-xs text-muted-foreground">
                {skill.reason ? reasonText[skill.reason] : skill.description}
              </p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
