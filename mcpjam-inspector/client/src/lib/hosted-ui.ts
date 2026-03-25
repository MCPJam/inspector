export const HOSTED_LOCAL_ONLY_TOOLTIP = "Available locally (npx / desktop)";

export function getHostedTransportLabel(
  transportType: "stdio" | "http",
): string {
  return transportType === "http" ? "HTTPS" : "STDIO";
}
