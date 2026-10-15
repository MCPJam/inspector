// An explicit own-key selection keeps local runner fixtures on the local rail
// when the hosted catalog adds the same model.
export const LOCAL_EVAL_MODEL = {
  model: "gpt-4-turbo",
  provider: "openai",
  legacySelection: {
    source: "legacy" as const,
    modelId: "openai/gpt-4-turbo",
    provider: "openai",
  },
};
