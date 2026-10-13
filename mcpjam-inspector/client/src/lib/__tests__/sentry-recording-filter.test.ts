import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  filterReplayRecordingPayload,
  scrubRecordingEvents,
  filterRecordingEnvelope,
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
    expect(scrubRecordingEvents(structuredClone(events))).toEqual([
      { ...events[0], data: { ...events[0].data, href: SCRUBBED } },
      events[1],
    ]);
  });

  it("masks customer-derived attributes in full snapshots and keeps layout", () => {
    const snapshot = {
      type: 2,
      timestamp: 3,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: "div",
              attributes: {
                class: "flex gap-2",
                id: "repo-row-acme/billing",
                "data-testid": "prompt-arg-customer_email",
                "data-owner": "ada@example.test",
                name: "acme-billing",
                role: "row",
              },
              childNodes: [
                {
                  type: 2,
                  id: 3,
                  tagName: "img",
                  attributes: { rr_width: "32px", rr_height: "32px" },
                  childNodes: [],
                },
                {
                  type: 2,
                  id: 4,
                  tagName: "style",
                  attributes: { _cssText: ".a { color: red; }" },
                  childNodes: [],
                },
              ],
            },
          ],
        },
      },
    };
    const [out] = scrubRecordingEvents([snapshot]) as [typeof snapshot];
    const row = out.data.node.childNodes[0];
    expect(row.attributes).toEqual({
      class: "flex gap-2",
      id: "***",
      "data-testid": "***",
      "data-owner": "***",
      name: "***",
      role: "row",
    });
    expect(row.childNodes[0].attributes).toEqual({
      rr_width: "32px",
      rr_height: "32px",
    });
    expect(row.childNodes[1].attributes).toEqual({
      _cssText: ".a { color: red; }",
    });
  });

  it("masks attributes that mutations add or change", () => {
    const mutation = {
      type: 3,
      timestamp: 4,
      data: {
        source: 0,
        texts: [],
        removes: [],
        adds: [
          {
            parentId: 2,
            nextId: null,
            node: {
              type: 2,
              id: 9,
              tagName: "span",
              attributes: { "data-email": "ada@example.test", class: "x" },
              childNodes: [],
            },
          },
        ],
        attributes: [
          { id: 2, attributes: { id: "prompt-arg-ada", hidden: null } },
          {
            id: 3,
            attributes: {
              style: {
                "--label": '"Ada Lovelace"',
                color: "red",
                width: false,
              },
            },
          },
        ],
      },
    };
    const json = JSON.stringify(scrubRecordingEvents([mutation]));
    expect(json).not.toContain("ada");
    expect(json).not.toContain("Ada");
    const [out] = JSON.parse(json);
    expect(out.data.adds[0].node.attributes).toEqual({
      "data-email": "***",
      class: "x",
    });
    expect(out.data.attributes[0].attributes).toEqual({
      id: "***",
      hidden: null,
    });
    expect(out.data.attributes[1].attributes.style).toMatchObject({
      color: "red",
      width: false,
    });
  });
});

describe("scrubRecordingEvents, credentials", () => {
  const TOKEN = "kd7a8f9g0h1j2k3l4m5n6p7q8r9s";
  const SHARE = `https://app.mcpjam.com/results/${TOKEN}`;

  it("scrubs credential URLs out of stylesheet text, which no Sentry option masks", () => {
    const snapshot = {
      type: 2,
      timestamp: 3,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: "style",
              attributes: { _cssText: `.hero { background: url(${SHARE}); }` },
              childNodes: [
                {
                  type: 3,
                  id: 3,
                  isStyle: true,
                  textContent: `.card { background: url(${SHARE}); }`,
                },
              ],
            },
          ],
        },
      },
    };
    const rule = {
      type: 3,
      timestamp: 4,
      data: {
        source: 8,
        id: 2,
        adds: [{ rule: `.x { background: url(${SHARE}); }`, index: 0 }],
      },
    };
    const out = scrubRecordingEvents([snapshot, rule]);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).toContain("/results/[redacted]");
  });

  it("scrubs credentials out of custom events at every level", () => {
    const breadcrumb = {
      type: 5,
      timestamp: 5,
      data: {
        tag: "breadcrumb",
        payload: { category: "navigation", data: { to: `/results/${TOKEN}` } },
      },
    };
    expect(JSON.stringify(scrubRecordingEvents([breadcrumb]))).not.toContain(
      TOKEN,
    );
  });

  it("refuses a recording with an event type it does not understand", () => {
    expect(scrubRecordingEvents([{ type: 99, data: {} }])).toBeNull();
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

it("fixes filtered recording length and preserves unrelated items", async () => {
  const recording = `${HEADER}${JSON.stringify(events)}`;
  const [headers, items] = await filterRecordingEnvelope([{ event_id: "1" }, [
    [{ type: "replay_event" }, { urls: [] }],
    [{ type: "replay_recording", length: recording.length }, recording],
  ]]);
  expect(headers).toEqual({ event_id: "1" });
  expect(items[0]).toEqual([{ type: "replay_event" }, { urls: [] }]);
  expect(items[1][1]).toContain(SCRUBBED);
  expect(items[1][0].length).toBe(new TextEncoder().encode(String(items[1][1])).length);
});
