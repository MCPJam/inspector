import { ListChecks } from "lucide-react";
import type { ComposerFormEntry } from "@/components/elicitation/composer-form-store";

/**
 * The thread's status lines while extension forms wait on this chat: one
 * "<server> requests information" per request, then "Waiting for your
 * answer" with the number still queued behind the card.
 */
export function ComposerFormStatus({
  forms,
}: {
  forms: readonly ComposerFormEntry[];
}) {
  if (!forms.length) return null;
  const queued = forms.length - 1;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="composer-form-status"
      className="space-y-2 px-2 pb-3 text-sm text-muted-foreground"
    >
      {forms.map((form) => (
        <p key={form.id} className="[overflow-wrap:anywhere]">
          {form.serverName} requests information
        </p>
      ))}
      <p className="flex items-center gap-1.5">
        <ListChecks aria-hidden="true" className="size-4 shrink-0" />
        Waiting for your answer
        {queued > 0 ? ` · ${queued} more waiting` : ""}
      </p>
    </div>
  );
}
