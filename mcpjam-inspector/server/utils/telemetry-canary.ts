import { getSystemLogger } from "./request-logger.js";

/** One deterministic, content-free health probe per five-minute window. */
export function startTelemetryCanary(): () => void {
  const log = getSystemLogger("telemetry");
  const emit = () => log.event("telemetry_canary", {});
  emit();
  const timer = setInterval(emit, 300000);
  timer.unref();
  return () => clearInterval(timer);
}
