import { ERROR_MESSAGES } from "@/lib/error-messages";
export type ConvexBlobLoadErrorKind = "transient" | "generic";

export function formatConvexBlobLoadError(rawMessage: string): {
  title: string;
  description: string;
  kind: ConvexBlobLoadErrorKind;
  alertVariant: "default" | "destructive";
} {
  const m = rawMessage.trim();
  const lower = m.toLowerCase();

  const isTransient =
    lower.includes("connection lost") ||
    lower.includes("in flight") ||
    lower.includes("network error") ||
    lower.includes("network request failed") ||
    lower.includes("failed to fetch");

  if (isTransient) {
    return {
      kind: "transient",
      title: ERROR_MESSAGES.connectionInterrupted,
      description:
        ERROR_MESSAGES.weLostContactWithTheServerWhileLoadingThisTrace,
      alertVariant: "default",
    };
  }

  return {
    kind: "generic",
    title: ERROR_MESSAGES.couldnTLoadTrace,
    description:
      ERROR_MESSAGES.somethingWentWrongWhileLoadingTheRecordedTraceTryAgain,
    alertVariant: "destructive",
  };
}
