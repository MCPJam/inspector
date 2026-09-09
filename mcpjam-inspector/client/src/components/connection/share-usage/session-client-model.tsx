/**
 * "Which client and which model ran this session?" — the one line that answers
 * it, in the session-detail header of BOTH products. Swarm and User Testing
 * render the same {@link ShareUsageThreadDetail}, so the treatment is shared by
 * construction rather than by two components agreeing to look alike.
 *
 * From user research (Sep 4): a reader with a transcript in front of them
 * forgot which model produced it, and the answer was only reachable through the
 * Raw / trace tabs. So this is session IDENTITY, not a detail — it sits beside
 * the session name, and it never hides behind the host's nickname: a host
 * called "staging bot" still reads `Claude · Claude Haiku 4.5`.
 */
import {
  getModelById,
  getCanonicalModelId,
  hostedModelDefinitionsFromSnapshot,
  SUPPORTED_MODELS,
  type ModelDefinition,
} from "@/shared/types";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import { compactModelIdTail } from "@/lib/environment-label";
import { findHostStyle } from "@/lib/client-styles";
import type { HostStyleId } from "@/lib/client-styles";
import { useHostedModelCatalog } from "@/hooks/use-hosted-model-catalog";
import { useSessionHistoricalHostConfig } from "@/hooks/useSharedChatThreads";
import { cn } from "@/lib/utils";

/**
 * The client a session ran on, in the product's own brand words ("Claude",
 * "ChatGPT") rather than the host row's nickname.
 *
 * A BYO host style that no preset claims is not nameless — it just has no brand
 * word, so the nickname is all we have and it is better than silence. `null`
 * when we know neither.
 */
export function clientLabelForSession(args: {
  hostStyle?: string | null;
  hostName?: string | null;
}): string | null {
  const brand = findHostStyle(args.hostStyle as HostStyleId | null | undefined)
    ?.chatUi.label;
  if (brand) return brand;
  const nickname = args.hostName?.trim();
  return nickname ? nickname : null;
}

/**
 * The model a session ran on, as the catalog names it.
 *
 * Resolution order is widest-first: the live hosted catalog (curated names such
 * as "GPT-5"), then the BYOK statics, then the checked-in hosted snapshot — and
 * each is tried against the id as stored AND against its canonical form, since
 * sessions persist both the bare (`claude-haiku-4.5`) and prefixed
 * (`anthropic/claude-haiku-4.5`) shapes. An id no catalog knows still gets an
 * answer: its tail, which is what the reader would have read off the Raw tab.
 */
export function modelLabelForSession(
  modelId: string | undefined | null,
  hostedCatalog: readonly ModelDefinition[] = [],
): string | null {
  const id = modelId?.trim();
  if (!id) return null;

  const candidates: ModelDefinition[] = [
    ...hostedCatalog,
    ...SUPPORTED_MODELS,
    ...hostedModelDefinitionsFromSnapshot(),
  ];
  const canonical = getCanonicalModelId(id, undefined, candidates);
  const named =
    candidates.find((model) => model.id === id) ??
    getModelById(id) ??
    candidates.find((model) => model.id === canonical);

  return compactModelLabel(named?.name) || compactModelIdTail(id);
}

/**
 * The single string both products print. `Client · Model` when both are known;
 * whichever one is known otherwise. Never a placeholder — an invented "Unknown
 * model" would be a claim about the session, and the point of this label is
 * that it only ever states what actually ran.
 */
export function sessionClientModelLabel(
  client: string | null,
  model: string | null,
): string | null {
  if (client && model) return `${client} · ${model}`;
  return model ?? client;
}

/**
 * The header chip. Reads the session's pinned historical host config for the
 * client; the model comes from the session row itself (the pin is the fallback
 * for rows written before sessions carried their own model attribution).
 *
 * Renders nothing when the session names neither — the same silence the header
 * had before, rather than an empty chip.
 */
export function SessionClientModelChip({
  sessionId,
  modelId,
  className,
}: {
  sessionId: string;
  modelId?: string | null;
  className?: string;
}) {
  const { config } = useSessionHistoricalHostConfig({ sessionId });
  const { hostedCatalog } = useHostedModelCatalog();

  const client = clientLabelForSession({
    hostStyle: config?.hostStyle,
    hostName: config?.currentHostName,
  });
  const resolvedModelId = modelId ?? config?.modelId ?? null;
  const model = modelLabelForSession(resolvedModelId, hostedCatalog);
  const label = sessionClientModelLabel(client, model);
  if (!label) return null;

  return (
    <span
      data-testid="session-client-model"
      className={cn(
        "inline-flex min-w-0 shrink items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-foreground",
        className,
      )}
      // The exact id, for the reader who needs the version string and not the
      // brand words.
      title={resolvedModelId ? `${label} · ${resolvedModelId}` : label}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}
