import { expect, it } from "vitest";
import { preflightJudgeOf } from "../suite-run-preflight-org-keys";

it("keeps an empty organization judge selection unconfigured", () => {
  expect(
    preflightJudgeOf({
      judgeConfig: {
        goalCompletion: {
          autoRun: true,
          judgeModel: "",
          judgeSelection: {
            modelId: "",
            source: "org",
            connectionRef: { kind: "orgProvider", id: "connection" },
            fallback: { provider: "none", model: "none" },
          },
        },
      },
    }),
  ).toEqual({ kind: "default" });
});
