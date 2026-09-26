import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publicArtifactLink,
  withPublicArtifactLinks,
  withPublicTraceArtifactLinks,
} from "../artifact-links.js";

/**
 * MJ-005 — public v1 responses carry artifact links only as signed
 * `/web/artifact` links on the backend's HTTP origin; any other value in an
 * artifact field reads as `null`.
 */

const SITE = "https://rt-http.example.com";
const SIGNED = `${SITE}/web/artifact?t=eyJ2IjoxfQ.c2ln`;
const DEFAULT_HOST_SIGNED =
  "https://happy-otter-123.convex.site/web/artifact?t=eyJ2IjoxfQ.c2ln";
const STORAGE_URL =
  "https://happy-otter-123.convex.cloud/api/storage/0b6c7c1e-8d0e-4f0a-9d7e-1a2b3c4d5e6f";

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", SITE);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publicArtifactLink", () => {
  it("keeps a signed link on the configured backend origin", () => {
    expect(publicArtifactLink(SIGNED)).toBe(SIGNED);
  });

  it("keeps a signed link on a default convex.site host", () => {
    expect(publicArtifactLink(DEFAULT_HOST_SIGNED)).toBe(DEFAULT_HOST_SIGNED);
  });

  it("keeps a local backend's link when that is the configured origin", () => {
    vi.stubEnv("CONVEX_HTTP_URL", "http://127.0.0.1:3211");
    const local = "http://127.0.0.1:3211/web/artifact?t=abc.def";
    expect(publicArtifactLink(local)).toBe(local);
  });

  it("reads a storage URL as absent", () => {
    expect(publicArtifactLink(STORAGE_URL)).toBeNull();
  });

  it.each([
    ["no token", `${SITE}/web/artifact`],
    ["an empty token", `${SITE}/web/artifact?t=`],
    ["another path", `${SITE}/web/artifacts?t=abc.def`],
    ["a nested path", `${SITE}/x/web/artifact?t=abc.def`],
    ["another origin", "https://cdn.example.net/web/artifact?t=abc.def"],
    [
      "plain http on a remote host",
      "http://happy-otter-123.convex.site/web/artifact?t=abc.def",
    ],
    [
      "credentials",
      "https://user:pw@happy-otter-123.convex.site/web/artifact?t=abc.def",
    ],
    ["a fragment", `${SITE}/web/artifact?t=abc.def#frag`],
    ["not a URL", "web/artifact?t=abc.def"],
    ["an empty string", ""],
  ])("reads a link with %s as absent", (_label, value) => {
    expect(publicArtifactLink(value)).toBeNull();
  });

  it.each([null, undefined, 42, { url: SIGNED }])(
    "reads a non-string (%s) as absent",
    (value) => {
      expect(publicArtifactLink(value)).toBeNull();
    },
  );
});

describe("withPublicArtifactLinks", () => {
  it("nulls only the named fields that fail the check", () => {
    const row = {
      screenshotUrl: STORAGE_URL,
      widgetHtmlUrl: SIGNED,
      url: "https://example.com/page",
      title: STORAGE_URL,
    };
    expect(
      withPublicArtifactLinks(row, ["screenshotUrl", "widgetHtmlUrl"]),
    ).toEqual({
      screenshotUrl: null,
      widgetHtmlUrl: SIGNED,
      url: "https://example.com/page",
      title: STORAGE_URL,
    });
  });

  it("returns the same row when nothing changes, and adds no fields", () => {
    const row = { screenshotUrl: SIGNED, videoUrl: null };
    const checked = withPublicArtifactLinks(row, [
      "screenshotUrl",
      "videoUrl",
      "widgetHtmlUrl",
    ]);
    expect(checked).toBe(row);
    expect(checked).not.toHaveProperty("widgetHtmlUrl");
  });
});

describe("withPublicTraceArtifactLinks", () => {
  it("checks the recording and every per-row artifact link", () => {
    const envelope = {
      traceVersion: 1,
      messages: [{ role: "user", content: "hello" }],
      videoUrl: STORAGE_URL,
      videoMeta: { durationMs: 1000 },
      widgetSnapshots: [
        {
          toolCallId: "tc-1",
          widgetHtmlUrl: SIGNED,
          toolInputUrl: STORAGE_URL,
          toolOutputUrl: STORAGE_URL,
        },
      ],
      widgetRenderObservations: [
        { toolCallId: "tc-1", screenshotUrl: STORAGE_URL },
      ],
      browserInteractionSteps: [
        { toolCallId: "tc-1", screenshotUrl: DEFAULT_HOST_SIGNED },
        { toolCallId: "tc-2", screenshotUrl: STORAGE_URL },
      ],
    };

    const checked = withPublicTraceArtifactLinks(envelope) as typeof envelope;

    expect(JSON.stringify(checked)).not.toContain("/api/storage/");
    expect(checked.videoUrl).toBeNull();
    expect(checked.widgetSnapshots[0]).toEqual({
      toolCallId: "tc-1",
      widgetHtmlUrl: SIGNED,
      toolInputUrl: null,
      toolOutputUrl: null,
    });
    expect(checked.widgetRenderObservations[0].screenshotUrl).toBeNull();
    expect(checked.browserInteractionSteps.map((s) => s.screenshotUrl)).toEqual(
      [DEFAULT_HOST_SIGNED, null],
    );
    // Everything else is the backend's shape, unchanged.
    expect(checked.messages).toBe(envelope.messages);
    expect(checked.videoMeta).toBe(envelope.videoMeta);
  });

  it("keeps a signed recording link", () => {
    const envelope = { videoUrl: SIGNED };
    expect(withPublicTraceArtifactLinks(envelope)).toEqual({
      videoUrl: SIGNED,
    });
  });

  it("returns an envelope with nothing to check as it is", () => {
    const envelope = { messages: [{ role: "user", content: "hi" }] };
    expect(withPublicTraceArtifactLinks(envelope)).toBe(envelope);
    expect(withPublicTraceArtifactLinks(null)).toBeNull();
    const list = [STORAGE_URL];
    expect(withPublicTraceArtifactLinks(list)).toBe(list);
  });
});
