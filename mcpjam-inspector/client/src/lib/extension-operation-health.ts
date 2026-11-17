import { track } from "./analytics";
import { EXTENSION_OPERATION_ERROR_CODES } from "@/shared/extension-operation-event";

/**
 * One outcome per user-facing extension operation that can fail, for the
 * feature-health alert. Closed vocabulary only: never form values, message
 * text, server names, URLs or error messages.
 */
export type ExtensionOperation =
  "form_response" | "settings_save" | "app_message";
export type ExtensionOperationProfile = "chatgpt" | "codex" | "unknown";
/** What the person chose. Declining or cancelling is never a failure. */
export type ExtensionOperationChoice = "submit" | "decline" | "cancel";
export type ExtensionOperationOutcome = {
  operation: ExtensionOperation;
  host_profile: ExtensionOperationProfile;
  outcome: "success" | "failure" | "declined" | "cancelled";
  error_code: string;
};

/** A form answer's action, as the person's choice. */
export function formChoice(
  action: "accept" | "decline" | "cancel",
): ExtensionOperationChoice {
  return action === "accept" ? "submit" : action;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(
  EXTENSION_OPERATION_ERROR_CODES,
);

/** Refusals the person chose (an approval denied, a request cancelled). */
const USER_CHOICE_CODES: Readonly<
  Record<string, "declined" | "cancelled" | undefined>
> = {
  APPROVAL_DENIED: "declined",
  PLUGIN_WORKSPACE_CANCELLED: "cancelled",
  PLUGIN_INSTANCE_CANCELLED: "cancelled",
};

/** A catalog code from the error, or `other`. Never the error's message. */
export function extensionOperationErrorCode(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : undefined;
  return typeof code === "string" && KNOWN_CODES.has(code) ? code : "other";
}

function emit(outcome: ExtensionOperationOutcome) {
  track("extension_operation_completed", {
    ...outcome,
    location: "host_workspace",
  });
}

/**
 * Runs one attempt and records exactly one outcome for it. A rejection is a
 * failure unless the person chose it (a denied approval, a cancel) or the
 * operation was withdrawn underneath it (AbortError, not recorded).
 * `accepted` lets a caller count a resolved-but-refused result (for example
 * `false`) as a failure.
 */
export async function observeExtensionOperation<T>(
  input: {
    operation: ExtensionOperation;
    profile?: ExtensionOperationProfile;
    choice?: ExtensionOperationChoice;
  },
  run: () => Promise<T>,
  accepted: (value: T) => boolean = () => true,
): Promise<T> {
  const base = {
    operation: input.operation,
    host_profile: input.profile ?? "unknown",
  } as const;
  let value: T;
  try {
    value = await run();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      const code = extensionOperationErrorCode(error);
      emit({
        ...base,
        outcome: USER_CHOICE_CODES[code] ?? "failure",
        error_code: code,
      });
    }
    throw error;
  }
  if (!accepted(value)) {
    emit({ ...base, outcome: "failure", error_code: "refused" });
  } else {
    emit({
      ...base,
      outcome:
        input.choice === "decline"
          ? "declined"
          : input.choice === "cancel"
            ? "cancelled"
            : "success",
      error_code: "none",
    });
  }
  return value;
}
