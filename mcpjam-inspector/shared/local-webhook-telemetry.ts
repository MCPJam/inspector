export const LOCAL_WEBHOOK_RECEIVER_KINDS = ["local", "custom"] as const;

export const LOCAL_WEBHOOK_FAILURE_CATEGORIES: readonly string[] = [
  "callback_https_required",
  "callback_auth_required",
  "callback_connection_refused",
  "callback_timeout",
  "callback_tls_error",
  "callback_http_4xx",
  "callback_http_5xx",
  "callback_challenge_failed",
  "callback_error",
];

export function isLocalWebhookTelemetryEvent(event: unknown): boolean {
  return event === "local_webhook_receiver_selected" || event === "local_webhook_receiver_failed";
}
