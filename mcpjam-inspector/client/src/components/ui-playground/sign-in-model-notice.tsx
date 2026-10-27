import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import {
  FREE_TIER_MODEL_REASON,
  GUEST_LOCKED_MODEL_REASON,
} from "@/components/chat-v2/shared/available-models";
import type { ModelDefinition } from "@/shared/types";

/** A model locked until the viewer signs in (guest or free-tier lock). */
export function needsSignIn(
  model: ModelDefinition | null | undefined,
): boolean {
  return (
    !!model?.disabled &&
    (model.disabledReason === GUEST_LOCKED_MODEL_REASON ||
      model.disabledReason === FREE_TIER_MODEL_REASON)
  );
}

export type SignInLockedClient = { clientName: string; modelName: string };

/**
 * The composer notice for a model that only runs after sign-in, or null when
 * nothing is locked. Send stays disabled either way; this says why, where the
 * user is looking. Compare names each client, since its header shows no model.
 */
export function signInModelNotice({
  model,
  clients,
}: {
  model?: ModelDefinition | null;
  clients?: readonly SignInLockedClient[];
}): ReactNode {
  const lines: ReactNode[] = (clients ?? []).map(
    ({ clientName, modelName }) => (
      <p key={clientName}>
        <span className="font-medium">{clientName} can&apos;t run.</span> Its
        model, {modelName}, needs an account. Sign in to send, or choose another
        model.
      </p>
    ),
  );
  if (lines.length === 0 && model && needsSignIn(model)) {
    lines.push(
      <p key="model">
        <span className="font-medium">{model.name} needs an account.</span> Sign
        in to send, or choose another model.
      </p>,
    );
  }
  if (lines.length === 0) return null;
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
      data-testid="sign-in-model-notice"
      role="status"
    >
      <TriangleAlert className="mt-[2px] size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">{lines}</div>
    </div>
  );
}
