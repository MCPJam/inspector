import { useRef, useState } from "react";
import { revokeLocalStudyAccess } from "@/lib/local-study-controls";
type Revocation = {
  key: string;
  pending: boolean;
  reservationId?: string;
  revoked: boolean;
  cleanupComplete: boolean;
  error: string | null;
};
const initial = (key: string): Revocation => ({
  key,
  pending: false,
  revoked: false,
  cleanupComplete: false,
  error: null,
});

/** Revocation invalidates the send capability immediately, before network work. */
export function useLocalStudyRevocation(
  key: string,
  clearLocalTarget: () => void,
) {
  const current = useRef(key);
  current.current = key;
  const sequence = useRef(0);
  const [stored, update] = useState(() => initial(key));
  const state = stored.key === key ? stored : initial(key);
  const revoke = async (id = state.reservationId) => {
    if (!id) return;
    const attempt = ++sequence.current;
    clearLocalTarget();
    update({ ...initial(key), pending: true, reservationId: id });
    try {
      const result = await revokeLocalStudyAccess(id);
      if (current.current === key && sequence.current === attempt)
        update({
          key,
          ...result,
          pending: false,
          reservationId: id,
          error: null,
        });
    } catch (error) {
      if (current.current === key && sequence.current === attempt)
        update({
          ...initial(key),
          reservationId: id,
          error:
            error instanceof Error
              ? error.message
              : "Could not revoke this study's local access. Try again.",
        });
    }
  };
  return { ...state, revoke };
}
export type LocalStudyRevocation = ReturnType<typeof useLocalStudyRevocation>;
