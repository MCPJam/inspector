/**
 * The platform client a picker step's tools call: the server's own `/api/v1`
 * by self-dispatch, as the person who started the climb, with no browser
 * request to take a bearer from. Every call carries the step's marker
 * (`picker-headers.ts`): the round route and the trace route pass it to the
 * backend, which honors it only for the lease the step holds.
 */
import { PlatformApiClient } from "@mcpjam/sdk/platform";
import { getSelfFetch } from "../../utils/self-app.js";
import { pickerStepHeaders, type PickerStepSent } from "./picker-headers.js";

// Host is never resolved: self-dispatch routes on the path, under the /api/v1 mount.
const SELF_BASE_URL = "http://self.mcpjam.internal/api/v1";

/**
 * `roundKey` is the idempotency key of the round this attempt submits, sent on
 * the round route only: a retry of that one call replays the round it
 * registered, and a step attempt that runs again has a generation of its own,
 * so it never replays another attempt's. A resumed step names its key in the
 * call and sends none here.
 */
export function buildPickerPlatformClient(getBearer: () => Promise<string>, mark: PickerStepSent, roundKey?: string): PlatformApiClient {
  const headers = pickerStepHeaders(mark);
  return new PlatformApiClient({
    baseUrl: SELF_BASE_URL,
    getAuth: getBearer,
    fetch: async (input, init) => {
      const dispatch = getSelfFetch();
      if (!dispatch) throw new Error("In-process /api/v1 dispatch is not registered; a climb step cannot reach the platform.");
      const request = new Request(input, init);
      for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
      if (roundKey && request.method === "POST" && new URL(request.url).pathname.endsWith("/rounds")) request.headers.set("idempotency-key", roundKey);
      return dispatch(request);
    },
  });
}
