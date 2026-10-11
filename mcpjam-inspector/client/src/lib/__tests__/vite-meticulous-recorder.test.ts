import { describe, expect, it } from "vitest";
import { shouldRecordWithMeticulous } from "../../../vite-meticulous-recorder";

const stagingWeb = {
  recordingToken: "public-recording-token",
  environment: "staging",
  hostedMode: "true",
  buildSurface: "web",
};

describe("shouldRecordWithMeticulous", () => {
  it.each(["staging", "preview"])(
    "records a hosted web build of %s",
    (environment) => {
      expect(shouldRecordWithMeticulous({ ...stagingWeb, environment })).toBe(
        true,
      );
    },
  );

  it.each([undefined, ""])("stays off with recording token %j", (token) => {
    expect(
      shouldRecordWithMeticulous({ ...stagingWeb, recordingToken: token }),
    ).toBe(false);
  });

  it.each(["npm", "desktop-mac", "desktop-win", "local"])(
    "stays off for the %s build surface",
    (buildSurface) => {
      expect(shouldRecordWithMeticulous({ ...stagingWeb, buildSurface })).toBe(
        false,
      );
    },
  );

  it.each([undefined, "false"])(
    "stays off when hosted mode is %j",
    (hostedMode) => {
      expect(shouldRecordWithMeticulous({ ...stagingWeb, hostedMode })).toBe(
        false,
      );
    },
  );

  it.each(["production", undefined, "development"])(
    "fails a %j build that has a recording token",
    (environment) => {
      expect(() =>
        shouldRecordWithMeticulous({ ...stagingWeb, environment }),
      ).toThrow(/METICULOUS_RECORDING_TOKEN/);
    },
  );

  it("does not fail a production build without a recording token", () => {
    expect(
      shouldRecordWithMeticulous({
        ...stagingWeb,
        recordingToken: undefined,
        environment: "production",
      }),
    ).toBe(false);
  });
});
