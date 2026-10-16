import { describe, expect, it } from "vitest";
import {
  isPluginServerUnavailableDataPart,
  PLUGIN_SERVER_UNAVAILABLE_DATA_PART_TYPE,
} from "../plugin-server-unavailable";

const part = (data: unknown) => ({
  type: PLUGIN_SERVER_UNAVAILABLE_DATA_PART_TYPE,
  data,
});

describe("plugin server unavailable data part", () => {
  it("accepts servers with a known reason, with or without the chat id", () => {
    expect(
      isPluginServerUnavailableDataPart(
        part({
          servers: [
            { serverId: "srv_1", reason: "needs_auth" },
            { serverId: "srv_2", reason: "unreachable" },
          ],
          chatSessionId: "chat_1",
        }),
      ),
    ).toBe(true);
    expect(
      isPluginServerUnavailableDataPart(
        part({ servers: [{ serverId: "srv_1", reason: "unreachable" }] }),
      ),
    ).toBe(true);
  });

  it("rejects an unknown reason rather than showing a notice without copy", () => {
    expect(
      isPluginServerUnavailableDataPart(
        part({ servers: [{ serverId: "srv_1", reason: "invented_later" }] }),
      ),
    ).toBe(false);
  });

  it("rejects the wrong part type and malformed envelopes", () => {
    const servers = [{ serverId: "srv_1", reason: "needs_auth" }];
    expect(
      isPluginServerUnavailableDataPart({
        type: "data-history-notice",
        data: { servers },
      }),
    ).toBe(false);
    for (const data of [
      null,
      {},
      { servers: [] },
      { servers: [{ reason: "needs_auth" }] },
      { servers: [{ serverId: "", reason: "needs_auth" }] },
      { servers, chatSessionId: "" },
      { servers, chatSessionId: 7 },
    ]) {
      expect(isPluginServerUnavailableDataPart(part(data))).toBe(false);
    }
    expect(isPluginServerUnavailableDataPart(null)).toBe(false);
  });
});
