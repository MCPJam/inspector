import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  filterReplayRecordingPayload,
  scrubRecordingEvents,
  withRecordingFilter,
} from "../sentry-recording-filter";

const NAMED = "https://app.mcpjam.com/servers/acme-billing";
const SCRUBBED = "https://app.mcpjam.com/servers/[name]";
const events = [
  { type: 4, data: { href: NAMED, width: 1280, height: 900 }, timestamp: 1 },
  { type: 3, data: { source: 2, type: 0, id: 4 }, timestamp: 2 },
];
const HEADER = '{"segment_id":3}\n';

describe("scrubRecordingEvents", () => {
  it("scrubs the page URL of every Meta event and leaves the rest", () => {
    expect(scrubRecordingEvents(events)).toEqual([
      { ...events[0], data: { ...events[0].data, href: SCRUBBED } },
      events[1],
    ]);
  });
});

describe("filterReplayRecordingPayload", () => {
  it("filters an uncompressed recording", async () => {
    const out = await filterReplayRecordingPayload(
      `${HEADER}${JSON.stringify(events)}`,
    );
    expect(typeof out).toBe("string");
    expect(out).toContain(HEADER);
    expect(out).toContain(SCRUBBED);
    expect(out).not.toContain("acme");
  });

  it("decompresses, filters and recompresses a zlib recording", async () => {
    const compressed = deflateSync(JSON.stringify(events));
    const header = new TextEncoder().encode(HEADER);
    const payload = new Uint8Array(header.length + compressed.length);
    payload.set(header);
    payload.set(compressed, header.length);

    const out = (await filterReplayRecordingPayload(payload)) as Uint8Array;
    expect(out).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(out.subarray(0, header.length))).toBe(
      HEADER,
    );
    const body = JSON.parse(
      inflateSync(Buffer.from(out.subarray(header.length))).toString("utf8"),
    );
    expect(body[0].data.href).toBe(SCRUBBED);
  });

  it("refuses a recording it cannot read", async () => {
    expect(await filterReplayRecordingPayload("no header line")).toBeNull();
    expect(
      await filterReplayRecordingPayload(
        new TextEncoder().encode(`${HEADER}not zlib`),
      ),
    ).toBeNull();
    expect(await filterReplayRecordingPayload(42)).toBeNull();
  });
});

describe("withRecordingFilter", () => {
  it("filters replay recordings, fixes their length and passes the rest through", async () => {
    const send = vi.fn(async () => ({}));
    const flush = vi.fn(async () => true);
    const transport = withRecordingFilter({ send, flush });
    const recording = `${HEADER}${JSON.stringify(events)}`;
    await transport.send([
      { event_id: "1" },
      [
        [{ type: "replay_event" }, { urls: [] }],
        [{ type: "replay_recording", length: recording.length }, recording],
      ],
    ] as never);
    const [[headers, items]] = send.mock.calls[0] as unknown as [
      [unknown, Array<[Record<string, unknown>, unknown]>],
    ];
    expect(headers).toEqual({ event_id: "1" });
    expect(items[0]).toEqual([{ type: "replay_event" }, { urls: [] }]);
    const [header, payload] = items[1];
    expect(payload).toContain(SCRUBBED);
    expect(header).toEqual({
      type: "replay_recording",
      length: new TextEncoder().encode(payload as string).length,
    });

    // An unreadable recording is not sent; other items are.
    await transport.send([
      {},
      [
        [{ type: "replay_event" }, {}],
        [{ type: "replay_recording", length: 3 }, "bad"],
      ],
    ] as never);
    const [[, second]] = send.mock.calls[1] as unknown as [
      [unknown, Array<[Record<string, unknown>, unknown]>],
    ];
    expect(second).toEqual([[{ type: "replay_event" }, {}]]);

    // Envelopes without a recording go out as they are.
    const error = [{}, [[{ type: "event" }, { message: "x" }]]];
    await transport.send(error as never);
    expect(send.mock.calls[2][0]).toBe(error);
    await transport.flush(5);
    expect(flush).toHaveBeenCalledWith(5);
  });
});
