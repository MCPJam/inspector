import { beforeEach, describe, expect, it, vi } from "vitest";

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

import {
  REASONING_EFFORT_NOTICE_DATA_PART_TYPE,
  REASONING_EFFORT_NOTICE_MESSAGE,
} from "@/shared/reasoning-effort-notice";
import { noteTurnNoticePart } from "../turn-notice-parts";

describe("noteTurnNoticePart: reasoning effort notice", () => {
  beforeEach(() => toastInfo.mockClear());

  it("says the turn ran without its effort, in one toast that does not stack", () => {
    const part = {
      type: REASONING_EFFORT_NOTICE_DATA_PART_TYPE,
      data: { reason: "custom_provider" },
    };
    expect(noteTurnNoticePart(part, "chat-1")).toBe(true);
    expect(noteTurnNoticePart(part, "chat-1")).toBe(true);
    expect(toastInfo).toHaveBeenCalledTimes(2);
    expect(toastInfo).toHaveBeenLastCalledWith(
      REASONING_EFFORT_NOTICE_MESSAGE,
      { id: REASONING_EFFORT_NOTICE_DATA_PART_TYPE },
    );
  });

  it("leaves a part with an unknown reason to other handlers", () => {
    expect(
      noteTurnNoticePart(
        {
          type: REASONING_EFFORT_NOTICE_DATA_PART_TYPE,
          data: { reason: "something_else" },
        },
        "chat-1",
      ),
    ).toBe(false);
    expect(toastInfo).not.toHaveBeenCalled();
  });
});
