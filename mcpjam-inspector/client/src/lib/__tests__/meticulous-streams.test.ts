import { describe, expect, it } from "vitest";
import { createStreamRedactor } from "../meticulous-streams";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const fromB64 = (data: string) => Buffer.from(data, "base64");
const batch = (
  texts: string[],
  completed = false,
  url = "/api/mcp/chat-v2",
) => ({
  url,
  method: "POST",
  completed,
  chunks: texts.map((text, index) => ({
    offsetMs: index * 10,
    data: b64(text),
  })),
});
const joined = (entry: { chunks: { data: string }[] }) =>
  Buffer.concat(entry.chunks.map((c) => fromB64(c.data))).toString();

describe("createStreamRedactor", () => {
  it("masks a secret field split across two chunks and keeps the boundaries", () => {
    const sse =
      'data: {"type":"tool-result","output":{"apiKey":"sk-abcdef"}}\n\n';
    const cut = sse.indexOf("abc");
    const entry = batch([sse.slice(0, cut), sse.slice(cut)]);
    const redacted = createStreamRedactor()(entry);
    expect(joined(redacted)).toBe(
      'data: {"type":"tool-result","output":{"apiKey":"*********"}}\n\n',
    );
    expect(fromB64(redacted.chunks[0].data).length).toBe(cut);
    expect(redacted.chunks[1].offsetMs).toBe(10);
  });

  it("masks a value split across two batches of the same stream", () => {
    const redact = createStreamRedactor();
    const first = redact(batch(['{"apiKey":"sk-']));
    const second = redact(batch(['abcdef","ok":true}']));
    expect(joined(first)).toBe('{"apiKey":"***');
    expect(joined(second)).toBe('******","ok":true}');
  });

  it("masks a field whose key is split across two batches", () => {
    const redact = createStreamRedactor();
    redact(batch(['{"api']));
    expect(joined(redact(batch(['Key":"sk-1"}'])))).toBe('Key":"****"}');
  });

  it("masks a bearer token split across two batches", () => {
    const redact = createStreamRedactor();
    expect(joined(redact(batch(["Authorization: Bearer ab"])))).toBe(
      "Authorization: Bearer **",
    );
    expect(joined(redact(batch(["cd\n"])))).toBe("**\n");
  });

  it("keeps streams apart by url and forgets a completed one", () => {
    const redact = createStreamRedactor();
    redact(batch(['{"token":"t-'], false, "/a"));
    expect(joined(redact(batch(['plain"}'], false, "/b")))).toBe('plain"}');
    redact(batch(['1"}'], true, "/a"));
    expect(joined(redact(batch(['2"}'], false, "/a")))).toBe('2"}');
  });

  it("keeps a multi-byte character split between batches when the second masks", () => {
    const redact = createStreamRedactor();
    const accent = Buffer.from("é", "utf8");
    const first = {
      url: "/x",
      method: "POST",
      completed: false,
      chunks: [
        {
          offsetMs: 0,
          data: Buffer.concat([
            Buffer.from('"a":"'),
            accent.subarray(0, 1),
          ]).toString("base64"),
        },
      ],
    };
    const second = {
      ...first,
      chunks: [
        {
          offsetMs: 1,
          data: Buffer.concat([
            accent.subarray(1),
            Buffer.from('","token":"t"}'),
          ]).toString("base64"),
        },
      ],
    };
    const out1 = redact(first);
    const out2 = redact(second);
    expect(out1).toBe(first);
    const bytes = Buffer.concat([
      ...out1.chunks.map((c) => fromB64(c.data)),
      ...out2.chunks.map((c) => fromB64(c.data)),
    ]);
    expect(bytes.toString()).toBe('"a":"é","token":"*"}');
  });

  it("returns the same entry when nothing is secret", () => {
    const entry = batch(['{"ok":true}']);
    expect(createStreamRedactor()(entry)).toBe(entry);
  });
});
