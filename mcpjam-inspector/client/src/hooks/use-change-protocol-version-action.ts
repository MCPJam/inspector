import { useCallback } from "react";
import { track } from "@/lib/analytics";
import { useAppNavigate } from "@/lib/app-navigation";
import { buildHostFocusTabPath } from "@/components/hosts/host-verify-deep-link";
import { isProtocolVersionPinFailure } from "@/lib/protocol-version-pin";
import { PROTOCOL_VERSION_PIN_CODE } from "@/components/chat-v2/shared/chat-helpers";

/**
 * The "Change protocol version" action for a chat surface, or `undefined` when
 * this error isn't a pinned-version refusal.
 *
 * Shared rather than written per surface because the same failure renders in
 * four places (single chat, both compare cards, the server card) and the first
 * three shipped inconsistently — the action existed on one and was simply
 * absent on the others, which is invisible in review and total for the user.
 *
 * `hostId` is the client whose pin caused this. Callers that know a more
 * specific one than the turn's own — a compare column, where each column is a
 * different host — should pass theirs; without it the link degrades to the
 * clients list rather than opening the wrong client's settings.
 */
export function useChangeProtocolVersionAction(args: {
  error: { code?: string; message?: string } | null | undefined;
  hostId?: string | null;
  /** Analytics `location`, so the surfaces stay distinguishable. */
  location: string;
}): (() => void) | undefined {
  const { error, hostId, location } = args;
  const navigate = useAppNavigate();

  const isPinFailure =
    error?.code === PROTOCOL_VERSION_PIN_CODE ||
    isProtocolVersionPinFailure(undefined, error?.message);

  const onChangeProtocolVersion = useCallback(() => {
    track("change_protocol_version_clicked", {
      location,
      has_host_id: Boolean(hostId),
    });
    navigate(buildHostFocusTabPath(hostId, "protocol"));
  }, [hostId, location, navigate]);

  return isPinFailure ? onChangeProtocolVersion : undefined;
}
