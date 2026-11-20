import { errors } from "undici";
import { describe, expect, it } from "vitest";
import { rebuildSentryEvent } from "@mcpjam/sdk/internal/telemetry";

// The strict Sentry boundary lists undici's error classes by exact name, by
// hand, because no source we own declares them. This ties that list to the
// undici this server installs: an upgrade that adds or renames a class fails
// here instead of quietly reporting it as `UnknownError`.
describe("undici error names through the strict Sentry boundary", () => {
  // `name` is set in each constructor, not on the class. The arguments are
  // the widest any of them takes: (message, code, { headers, body | data }).
  const names = [
    ...new Set(
      Object.values(errors).map(
        (ErrorClass) =>
          (Reflect.construct(ErrorClass, ["", 0, {}]) as Error).name,
      ),
    ),
  ];

  it.each(names)("keeps %s as its own exception type", (name) => {
    const event = rebuildSentryEvent({
      exception: { values: [{ type: name }] },
    }) as { exception: { values: Array<{ type: string }> } };

    expect(event.exception.values[0]?.type).toBe(name);
  });
});
