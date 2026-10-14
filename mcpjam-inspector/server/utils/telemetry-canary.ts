import { getSystemLogger } from "./request-logger.js";
import { HOSTED_MODE } from "../config.js";

/** One deterministic, content-free health probe per five-minute window. */
export function startTelemetryCanary(): () => void {
  if (!HOSTED_MODE) return () => undefined;
  const log = getSystemLogger("telemetry");
  const emit = () => log.event("telemetry_canary", {});
  emit();
  const timer = setInterval(emit, 300000);
  timer.unref();
  return () => clearInterval(timer);
}
