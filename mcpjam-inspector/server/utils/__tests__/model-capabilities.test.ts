/**
 * model-capabilities.test.ts — capability-based Computer Use eligibility.
 *
 * The OpenRouter catalog fetch is stubbed at the global-fetch level; the
 * module-level cache is reset between tests via the exported test hook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetModelCapabilitiesForTests,
  modelSupportsComputerUse,
} from "../model-capabilities";

function catalogResponse(
  data: Array<{
    id: string;
    input_modalities?: string[];
    supported_parameters?: string[];
  }>
) {
  return new Response(
    JSON.stringify({
      data: data.map((m) => ({
        id: m.id,
        architecture: { input_modalities: m.input_modalities ?? [] },
        supported_parameters: m.supported_parameters ?? [],
      })),
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  __resetModelCapabilitiesForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("modelSupportsComputerUse", () => {
  it("resolves mapped Claude ids offline — no catalog fetch", async () => {
    await expect(
      modelSupportsComputerUse("anthropic/claude-haiku-4.5")
    ).resolves.toBe(true);
    await expect(modelSupportsComputerUse("claude-opus-4-6")).resolves.toBe(
      true
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a non-Claude model with image input + tools", async () => {
    fetchMock.mockResolvedValue(
      catalogResponse([
        {
          id: "openai/gpt-5",
          input_modalities: ["text", "image"],
          supported_parameters: ["tools", "temperature"],
        },
      ])
    );

    await expect(modelSupportsComputerUse("openai/gpt-5")).resolves.toBe(true);
    // Catalog ids match case-insensitively (object-shaped ids too).
    await expect(
      modelSupportsComputerUse({ id: "OpenAI/GPT-5" })
    ).resolves.toBe(true);
  });

  it("rejects models missing vision or tool calling", async () => {
    fetchMock.mockResolvedValue(
      catalogResponse([
        {
          id: "some/text-only-model",
          input_modalities: ["text"],
          supported_parameters: ["tools"],
        },
        {
          id: "some/vision-no-tools-model",
          input_modalities: ["text", "image"],
          supported_parameters: ["temperature"],
        },
      ])
    );

    await expect(
      modelSupportsComputerUse("some/text-only-model")
    ).resolves.toBe(false);
    await expect(
      modelSupportsComputerUse("some/vision-no-tools-model")
    ).resolves.toBe(false);
  });

  it("rejects ids missing from the catalog, and empty/absent ids", async () => {
    fetchMock.mockResolvedValue(catalogResponse([]));

    await expect(modelSupportsComputerUse("nobody/unknown")).resolves.toBe(
      false
    );
    await expect(modelSupportsComputerUse("")).resolves.toBe(false);
    await expect(modelSupportsComputerUse(null)).resolves.toBe(false);
  });

  it("caches the catalog across lookups (one fetch)", async () => {
    fetchMock.mockResolvedValue(
      catalogResponse([
        {
          id: "openai/gpt-5",
          input_modalities: ["text", "image"],
          supported_parameters: ["tools"],
        },
      ])
    );

    await modelSupportsComputerUse("openai/gpt-5");
    await modelSupportsComputerUse("openai/gpt-5");
    await modelSupportsComputerUse("nobody/unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent lookups into a single in-flight fetch", async () => {
    fetchMock.mockResolvedValue(
      catalogResponse([
        {
          id: "openai/gpt-5",
          input_modalities: ["text", "image"],
          supported_parameters: ["tools"],
        },
      ])
    );

    const results = await Promise.all([
      modelSupportsComputerUse("openai/gpt-5"),
      modelSupportsComputerUse("openai/gpt-5"),
      modelSupportsComputerUse("nobody/unknown"),
    ]);
    expect(results).toEqual([true, true, false]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on catalog errors and backs off before refetching", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    await expect(modelSupportsComputerUse("openai/gpt-5")).resolves.toBe(false);
    // Within the failure-backoff window: no second fetch attempt.
    await expect(modelSupportsComputerUse("openai/gpt-5")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Claude ids stay eligible regardless of catalog availability.
    await expect(
      modelSupportsComputerUse("anthropic/claude-sonnet-4.6")
    ).resolves.toBe(true);
  });

  it("fails closed on a non-OK catalog response", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 503 }));
    await expect(modelSupportsComputerUse("openai/gpt-5")).resolves.toBe(false);
  });
});
