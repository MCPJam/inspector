import { MessageSquare, Target } from "lucide-react";
import { Textarea } from "@mcpjam/design-system/textarea";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
import {
  editGeneratedDraftFromUi,
  type GeneratedDraft,
} from "@/lib/mcpjam-agent/eval-workspace";

/** Review the case content; extraction diagnostics remain internal metadata. */
export function ImportedDraftEditor({
  scope,
  draft,
}: {
  scope: EvalAgentScope;
  draft: GeneratedDraft;
}) {
  const imported = draft.markdownImport!;
  const locked = draft.saving || Boolean(imported.prepared);
  return (
    <div className="space-y-4">
      <label className="block space-y-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-info">
          <MessageSquare className="size-4" aria-hidden />
          User Prompt
        </span>
        <Textarea
          aria-label="User Prompt"
          className="min-h-24 font-mono"
          value={draft.input.query}
          maxLength={20000}
          disabled={locked}
          onChange={(event) =>
            editGeneratedDraftFromUi(scope, draft.id, draft.revision, {
              steps: [
                { id: "prompt", kind: "prompt", prompt: event.target.value },
              ],
            })
          }
        />
      </label>
      <label className="block space-y-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-info">
          <Target className="size-4" aria-hidden />
          Expected Outcome
        </span>
        <Textarea
          aria-label="Expected Outcome"
          className="min-h-24 font-mono"
          value={draft.input.expectedOutput ?? ""}
          maxLength={10000}
          disabled={locked}
          onChange={(event) =>
            editGeneratedDraftFromUi(scope, draft.id, draft.revision, {
              expectedOutput: event.target.value,
            })
          }
        />
      </label>
    </div>
  );
}
