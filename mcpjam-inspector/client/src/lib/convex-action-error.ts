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
      title: "Connection interrupted",
      description:
        "We lost contact with the server while loading this trace. Check your connection and try again.",
      alertVariant: "default",
    };
  }

  return {
    kind: "generic",
    title: "Couldn't load trace",
    description:
      "Something went wrong while loading the recorded trace. Try again, or refresh the page if the problem continues.",
    alertVariant: "destructive",
  };
}
