import { serviceCredentialHeaders } from "../services/service-credential.js";

/** Keep the tester bearer and authenticate the server reading its saved connection. */
export function fetchScenarioExecutionConfig(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  return fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...serviceCredentialHeaders(),
    },
    // A custom service header must never follow a redirect to another origin.
    redirect: "error",
  });
}
