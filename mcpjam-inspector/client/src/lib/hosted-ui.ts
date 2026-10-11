import { HOSTED_MODE } from "@/lib/config";

export const HOSTED_LOCAL_ONLY_TOOLTIP = "Available locally (npx / desktop)";

export const SERVER_INPUT_TRANSPORT_HINT = HOSTED_MODE
  ? "Enter an HTTPS URL. STDIO works only in the local and desktop apps."
  : "HTTP, SSE, and stdio all work.";

export function getHostedTransportLabel(
  transportType: "stdio" | "http",
): string {
  return transportType === "http" ? "HTTPS" : "STDIO";
}
