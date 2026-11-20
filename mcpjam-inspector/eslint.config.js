// @ts-check
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

// Violations that predate a rule are recorded in eslint-suppressions.json, so
// `npm run lint` fails only on new ones. After fixing some, run
// `npm run lint:prune` to drop their entries.
export default [
  {
    ignores: [
      "dist/**",
      "out/**",
      "node_modules/**",
      "coverage/**",
      "**/*.bundled.ts",
      "**/*.generated.ts",
    ],
  },
  {
    files: ["client/src/**/*.{ts,tsx}", "server/**/*.ts", "shared/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // The source carries disable comments for rules this config does not load
    // (`import/extensions`, `@typescript-eslint/*`). Reporting them as unused
    // would bury the rules below.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    files: ["client/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["server/routes/web/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='logger'][callee.property.name=/^(warn|error|info)$/]",
          message:
            "Use logger.event() for production diagnostics in server/routes/web/. " +
            "Free-form logger.warn/error/info calls are not queryable in Axiom. " +
            "See server/utils/LOGGING.md for the typed event catalog.",
        },
      ],
    },
  },
];
