import { describe, expect, it } from "vitest";
import {
  maskOpenSecret,
  maskSecrets,
  maskSplitKey,
  maskText,
  openKeyAtEnd,
  openSecretAtEnd,
} from "../meticulous-secrets";

describe("maskSecrets", () => {
  it("masks nested secrets by key and returns the input when nothing changed", () => {
    expect(maskSecrets({ a: [{ accessToken: "x", n: 1 }] })).toEqual({
      a: [{ accessToken: "*", n: 1 }],
    });
    const plain = { name: "x", code: "NOT_FOUND" };
    expect(maskSecrets(plain)).toBe(plain);
  });
});

describe("maskText", () => {
  it("masks bearer tokens and fields escaped inside another JSON string", () => {
    expect(maskText("Authorization: Bearer abc.def")).toBe(
      "Authorization: Bearer *******",
    );
    expect(maskText('{"text":"{\\"access_token\\":\\"tok\\"}"}')).toBe(
      '{"text":"{\\"access_token\\":\\"***\\"}"}',
    );
    expect(maskText('{"code":"NOT_FOUND"}')).toBe('{"code":"NOT_FOUND"}');
  });

  it("masks a secret value the text ends inside of", () => {
    expect(maskText('{"n":1,"apiKey":"sk-abc')).toBe('{"n":1,"apiKey":"******');
    expect(maskText('{"n":1,"name":"abc')).toBe('{"n":1,"name":"abc');
  });
});

describe("openSecretAtEnd and maskOpenSecret", () => {
  it("reports how a text ends inside a secret and masks its continuation", () => {
    expect(openSecretAtEnd('{"apiKey":"***')).toBe("json");
    expect(openSecretAtEnd('{"text":"{\\"token\\":\\"**')).toBe("escaped");
    expect(openSecretAtEnd("x Bearer **")).toBe("bearer");
    expect(openSecretAtEnd('{"name":"ab')).toBeNull();
    expect(maskOpenSecret('cd","n":1}', "json")).toEqual({
      text: '**","n":1}',
      open: null,
    });
    expect(maskOpenSecret("cdef", "json")).toEqual({
      text: "****",
      open: "json",
    });
    expect(maskOpenSecret('cd\\"}"}', "escaped")).toEqual({
      text: '**\\"}"}',
      open: null,
    });
    expect(maskOpenSecret("cd end", "bearer")).toEqual({
      text: "** end",
      open: null,
    });
  });
});

describe("openKeyAtEnd and maskSplitKey", () => {
  it("joins a key split across batches before deciding whether it is secret", () => {
    expect(openKeyAtEnd('{"n":1,"api')).toEqual({
      partial: "api",
      escaped: false,
    });
    expect(openKeyAtEnd('{"a":"')).toBeNull();
    const key = { partial: "api", escaped: false };
    expect(maskSplitKey('Key":"sk-1"}', key)).toEqual({
      text: 'Key":"****"}',
      open: null,
    });
    expect(maskSplitKey('Key":"sk-', key)).toEqual({
      text: 'Key":"***',
      open: "json",
    });
    expect(maskSplitKey('Name":"x"}', key)).toEqual({
      text: 'Name":"x"}',
      open: null,
    });
  });
});
