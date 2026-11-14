import { createContext, useContext } from "react";
import type { AiRefusalAudience } from "@/shared/ai-refusal-copy";

/**
 * Who reads an organization AI key policy refusal inside a chat thread, and
 * the one action that fixes it. Parts of the thread that show a refusal (the
 * web search tool card) read it here instead of taking it through every
 * part. Set where the chat surface already resolves `useOrgModelsHandoff`.
 *
 * Without a provider (eval and swarm transcripts): member wording, no
 * action.
 */
export type OrgAiRefusalHandoff = {
  audience: AiRefusalAudience;
  /** Opens Organization → AI providers; only for viewers who may manage it. */
  onManageOrgProviders?: () => void;
};

const MEMBER: OrgAiRefusalHandoff = { audience: "member" };

const OrgAiRefusalHandoffContext = createContext<OrgAiRefusalHandoff>(MEMBER);

export const OrgAiRefusalHandoffProvider = OrgAiRefusalHandoffContext.Provider;

export function useOrgAiRefusalHandoff(): OrgAiRefusalHandoff {
  return useContext(OrgAiRefusalHandoffContext);
}

/**
 * The handoff for a chat surface. A visitor (a share link or hosted page)
 * never sees the organization's configuration; a viewer who may manage the
 * organization's providers gets the action; everyone else is a member.
 */
export function orgAiRefusalHandoff(args: {
  visitor?: boolean;
  onManageOrgProviders?: () => void;
}): OrgAiRefusalHandoff {
  if (args.visitor) return { audience: "visitor" };
  return args.onManageOrgProviders
    ? { audience: "admin", onManageOrgProviders: args.onManageOrgProviders }
    : MEMBER;
}
