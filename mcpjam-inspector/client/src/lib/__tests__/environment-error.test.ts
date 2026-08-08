import { describe, expect, it } from "vitest";
import {
  describeEnvironmentError,
  isNoServersError,
  readEnvironmentErrorPayload,
} from "@/lib/environment-error";

const NO_SERVERS_SENTENCE =
  'Environment "Billing · ChatGPT" resolves to no servers. Pick at least one server before launching.';

describe("readEnvironmentErrorPayload", () => {
  // The whole point of the change: the DOMAIN code lives in `details`, and it
  // used to be thrown away, which is why every failure rendered identically.
  it("prefers the domain code in details over the transport code", () => {
    const payload = readEnvironmentErrorPayload(
      {
        code: "conflict",
        message: NO_SERVERS_SENTENCE,
        details: { code: "ENV_NO_SERVERS", environmentId: "env_1" },
      },
      "fallback"
    );
    expect(payload.code).toBe("ENV_NO_SERVERS");
    expect(payload.message).toBe(NO_SERVERS_SENTENCE);
    expect(payload.details).toEqual({
      code: "ENV_NO_SERVERS",
      environmentId: "env_1",
    });
  });

  it("falls back to the transport code when there is no details code", () => {
    expect(
      readEnvironmentErrorPayload({ code: "not_found", message: "Gone" }, "f")
        .code
    ).toBe("not_found");
  });

  // Some route envelopes carry only one of these shapes; dropping either would
  // flatten an actionable failure into the generic fallback.
  it.each([
    [{ error: "from error string" }, "from error string"],
    [{ error: { message: "from error object" } }, "from error object"],
    [{ message: "from top-level message" }, "from top-level message"],
  ])("reads the message from %o", (body, expected) => {
    expect(readEnvironmentErrorPayload(body, "fallback").message).toBe(
      expected
    );
  });

  it.each([[null], [undefined], ["a string body"], [{}]])(
    "falls back for an unusable body (%o)",
    (body) => {
      expect(readEnvironmentErrorPayload(body, "fallback").message).toBe(
        "fallback"
      );
    }
  );

  it("omits code entirely rather than emitting undefined", () => {
    expect("code" in readEnvironmentErrorPayload({ message: "x" }, "f")).toBe(
      false
    );
  });
});

describe("describeEnvironmentError", () => {
  it("turns ENV_NO_SERVERS into an actionable warning", () => {
    const normalized = describeEnvironmentError({
      message: NO_SERVERS_SENTENCE,
      code: "ENV_NO_SERVERS",
    });
    expect(normalized.title).toBe("This environment has no servers");
    expect(normalized.severity).toBe("warning");
    // The backend's own sentence survives verbatim — it names the specific
    // environment, which no client-side copy can do.
    expect(normalized.oneLine).toBe(NO_SERVERS_SENTENCE);
    expect(normalized.rawCode).toBe("ENV_NO_SERVERS");
    expect(normalized.likelyCauses.length).toBeGreaterThan(0);
    expect(normalized.nextSteps.length).toBeGreaterThan(0);
  });

  // An ENV_ code we have no bespoke copy for still beats describeError: it
  // keeps the backend prose and surfaces the code in the details block.
  it("keeps the message and code for an unrecognized ENV_ code", () => {
    const normalized = describeEnvironmentError({
      message: "Something environment-shaped went wrong.",
      code: "ENV_SOMETHING_NEW",
    });
    expect(normalized.oneLine).toBe("Something environment-shaped went wrong.");
    expect(normalized.rawCode).toBe("ENV_SOMETHING_NEW");
    expect(normalized.nextSteps.length).toBeGreaterThan(0);
  });

  it("gives ENV_ARCHIVED and ENV_HOST_MISSING their own titles", () => {
    expect(
      describeEnvironmentError({ message: "m", code: "ENV_ARCHIVED" }).title
    ).toBe("This environment is archived");
    expect(
      describeEnvironmentError({ message: "m", code: "ENV_HOST_MISSING" }).title
    ).toBe("This environment's client no longer exists");
  });

  // Non-environment failures must not be dressed up as environment ones.
  it("delegates a non-ENV payload to describeError", () => {
    const normalized = describeEnvironmentError({
      message: "socket hang up",
      code: "internal_error",
    });
    expect(normalized.slug.startsWith("environment/")).toBe(false);
  });

  it("delegates a thrown Error to describeError", () => {
    const normalized = describeEnvironmentError(new Error("boom"));
    expect(normalized.slug.startsWith("environment/")).toBe(false);
    expect(typeof normalized.title).toBe("string");
  });
});

describe("isNoServersError", () => {
  it("matches only the zero-servers code", () => {
    expect(isNoServersError({ message: "m", code: "ENV_NO_SERVERS" })).toBe(
      true
    );
    expect(isNoServersError({ message: "m", code: "ENV_ARCHIVED" })).toBe(
      false
    );
    expect(isNoServersError({ message: "m" })).toBe(false);
    expect(isNoServersError(null)).toBe(false);
    expect(isNoServersError("ENV_NO_SERVERS")).toBe(false);
  });
});
