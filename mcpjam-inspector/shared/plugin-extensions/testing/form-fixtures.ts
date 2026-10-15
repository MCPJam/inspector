/** Disposable coverage supplement for fields not authored by Bits & Bolts. */
export const extendedFormFixture = {
  type: "object",
  required: ["choice", "count", "enabled"],
  properties: {
    choice: {
      type: "string",
      oneOf: [
        {
          const: "bolt",
          title: "Bolt",
          description: "Disposable threaded part",
          "x-openai-thumbnail": {
            src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
          },
        },
        {
          const: "washer",
          title: "Washer",
          description: "Disposable flat part",
        },
      ],
    },
    count: { type: "integer", minimum: 0, maximum: 8 },
    enabled: { type: "boolean" },
    note: {
      type: "string",
      "x-openai-suggestions": [
        { const: "spare", title: "Spare part", description: "Keep one spare" },
      ],
    },
    date: { type: "string", format: "date" },
    resource: {
      type: "string",
      format: "uri",
      "x-openai-input": {
        type: "resource",
        options: [
          {
            uri: "fixture://part",
            name: "Disposable part",
            _meta: {
              "openai/preview": {
                target: {
                  type: "resource_link",
                  uri: "fixture://preview",
                  name: "Part preview",
                },
              },
            },
          },
        ],
      },
    },
  },
};
export const unsupportedMixedFormFixture = {
  ...extendedFormFixture,
  properties: {
    ...extendedFormFixture.properties,
    future: { type: "string", "x-openai-input": { type: "future" } },
  },
};
