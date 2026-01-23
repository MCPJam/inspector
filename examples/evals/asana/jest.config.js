/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@mcpjam/sdk$": "<rootDir>/node_modules/@mcpjam/sdk/dist/index.mjs",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        isolatedModules: true,
        diagnostics: {
          ignoreCodes: [151002, 2307],
        },
      },
    ],
  },
  testMatch: ["**/*.test.ts"],
  testTimeout: 120000, // 2 minutes for LLM calls
};
