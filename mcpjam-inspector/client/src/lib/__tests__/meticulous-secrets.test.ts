import { describe, expect, it } from "vitest";
import { maskSecrets, maskText } from "../meticulous-secrets";

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
