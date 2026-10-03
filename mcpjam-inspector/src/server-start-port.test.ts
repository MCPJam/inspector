import { describe, expect, it } from "vitest";
import { resolveServerStartPort } from "./server-port-fallback.js";

describe("resolveServerStartPort", () => {
  it("starts from SERVER_PORT when the launcher set a valid one", () => {
    expect(resolveServerStartPort({ SERVER_PORT: "6276" }, 6274)).toBe(6276);
    expect(resolveServerStartPort({ SERVER_PORT: " 7000 " }, 6274)).toBe(7000);
  });

  it("keeps the default when SERVER_PORT is unset, empty or not a port", () => {
    expect(resolveServerStartPort({}, 6274)).toBe(6274);
    expect(resolveServerStartPort({ SERVER_PORT: "" }, 6274)).toBe(6274);
    expect(resolveServerStartPort({ SERVER_PORT: "auto" }, 6274)).toBe(6274);
    expect(resolveServerStartPort({ SERVER_PORT: "0" }, 6274)).toBe(6274);
    expect(resolveServerStartPort({ SERVER_PORT: "70000" }, 6274)).toBe(6274);
  });
});
