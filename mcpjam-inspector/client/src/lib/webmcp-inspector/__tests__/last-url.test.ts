import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WEBMCP_URL,
  readLastWebMcpUrl,
  writeLastWebMcpUrl,
  WEBMCP_LAST_URL_KEY,
} from "../last-url";

afterEach(() => {
  window.localStorage.removeItem(WEBMCP_LAST_URL_KEY);
});

describe("last WebMCP URL", () => {
  it("reads the default when nothing is stored", () => {
    expect(readLastWebMcpUrl()).toBe(DEFAULT_WEBMCP_URL);
  });

  it("round-trips a page URL", () => {
    writeLastWebMcpUrl("https://pizza.test/");
    expect(readLastWebMcpUrl()).toBe("https://pizza.test/");
  });

  it("ignores a blank write so a clear cannot wipe the last page", () => {
    writeLastWebMcpUrl("https://pizza.test/");
    writeLastWebMcpUrl("   ");
    expect(readLastWebMcpUrl()).toBe("https://pizza.test/");
  });
});
