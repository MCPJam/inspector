// The eng flow's tests, run from the repository root by `npm run test:eng`.
// A plain object, so it loads without the vitest package resolving here.
import { fileURLToPath } from "node:url";

export default {
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/eng/__tests__/**/*.test.ts"],
    environment: "node",
  },
};
