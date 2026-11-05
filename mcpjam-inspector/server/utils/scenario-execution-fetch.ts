import { serviceCredentialHeaders } from "../services/service-credential.js";

/** Keep the tester bearer and authenticate the server reading its saved connection. */
export function fetchScenarioExecutionConfig(
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      ...serviceCredentialHeaders(),
    },
    // A custom service header must never follow a redirect to another origin.
    redirect: "error",
  });
}
