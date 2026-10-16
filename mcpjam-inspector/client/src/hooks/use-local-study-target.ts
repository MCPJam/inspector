import { useRef, useState } from "react";
import {
  requestLocalStudySetup,
  type LocalStudySetup,
} from "@/lib/local-study-setup";

type StudyIdentity = {
  userId?: string;
  scenarioId?: string;
  accessVersion?: number;
};
type State = {
  key: string;
  requested: boolean;
  loading: boolean;
  error: string | null;
  ready?: LocalStudySetup;
  chatSessionId?: string;
};
const initial = (key: string): State => ({
  key,
  requested: false,
  loading: false,
  error: null,
});

function resolveTarget(state: State, chatSessionId?: string) {
  if (
    !state.requested ||
    !state.ready ||
    state.chatSessionId !== chatSessionId ||
    Date.parse(state.ready.expiresAt) <= Date.now()
  )
    return null;
  return { target: state.ready.target, token: state.ready.token };
}

/** Capabilities stay in memory and are never reused across actors or conversations. */
export function useLocalStudyTarget(identity: StudyIdentity) {
  const key = JSON.stringify([
    identity.userId,
    identity.scenarioId,
    identity.accessVersion,
  ]);
  const bound = useRef({ key, chats: new Set<string>() });
  if (bound.current.key !== key) bound.current = { key, chats: new Set() };
  const currentKey = useRef(key);
  currentKey.current = key;
  const attempt = useRef(0);
  const [stored, setStored] = useState<State>(() => initial(key));
  const state = stored.key === key ? stored : initial(key);
  const setup = async (chatSessionId: string) => {
    if (
      !identity.userId ||
      !identity.scenarioId ||
      identity.accessVersion === undefined ||
      !chatSessionId
    )
      return;
    const sequence = ++attempt.current;
    setStored({
      ...initial(key),
      requested: true,
      loading: true,
      chatSessionId,
    });
    try {
      const ready = await requestLocalStudySetup({
        scenarioId: identity.scenarioId,
        accessVersion: identity.accessVersion,
        chatSessionId,
      });
      if (currentKey.current === key && attempt.current === sequence) {
        bound.current.chats.add(chatSessionId);
        setStored({
          key,
          requested: true,
          loading: false,
          error: null,
          ready,
          chatSessionId,
        });
      }
    } catch (error) {
      if (currentKey.current === key && attempt.current === sequence)
        setStored({
          key,
          requested: true,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "Local study setup failed. Retry setup.",
          chatSessionId,
        });
    }
  };
  return {
    ...state,
    setup,
    resolveSendTarget: (id?: string) => resolveTarget(state, id),
    isBoundConversation: (id: string | null) =>
      Boolean(id && bound.current.chats.has(id)),
    useCloud: (id: string | null) => {
      if (!id || bound.current.chats.has(id)) return;
      attempt.current++;
      setStored({ ...state, requested: false, loading: false, error: null });
    },
    clearGrant: () => {
      attempt.current++;
      setStored(initial(key));
    },
  };
}
export type LocalStudyController = ReturnType<typeof useLocalStudyTarget>;
