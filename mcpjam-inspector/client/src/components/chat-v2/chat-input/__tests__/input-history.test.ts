import { describe, expect, it } from "vitest";
import {
  caretIsOnFirstLine,
  caretIsOnLastLine,
  collectInputHistory,
  navigateInputHistory,
  type InputHistoryNavigation,
} from "../input-history";

const userMessage = (text: string) => ({
  role: "user",
  parts: [{ type: "text", text }],
});
const assistantMessage = (text: string) => ({
  role: "assistant",
  parts: [{ type: "text", text }],
});

describe("collectInputHistory", () => {
  it("returns the user's own messages, newest first", () => {
    expect(
      collectInputHistory([
        userMessage("first"),
        assistantMessage("answer"),
        userMessage("second"),
      ]),
    ).toEqual(["second", "first"]);
  });

  it("skips assistant turns — you cannot have typed one", () => {
    expect(collectInputHistory([assistantMessage("hello")])).toEqual([]);
  });

  it("skips a message with no text, rather than offering a blank recall", () => {
    // An attachment sent without a message.
    expect(
      collectInputHistory([
        { role: "user", parts: [{ type: "file", url: "x" }] },
        userMessage("   "),
        userMessage("real"),
      ]),
    ).toEqual(["real"]);
  });

  it("collapses a repeat of the message before it", () => {
    // Resending the same prompt is one thing you typed; making someone press
    // Up twice to get past their own retry is the papercut this removes.
    expect(
      collectInputHistory([
        userMessage("retry me"),
        userMessage("retry me"),
        userMessage("newer"),
      ]),
    ).toEqual(["newer", "retry me"]);
  });

  it("keeps a repeat that is not adjacent", () => {
    expect(
      collectInputHistory([
        userMessage("same"),
        userMessage("between"),
        userMessage("same"),
      ]),
    ).toEqual(["same", "between", "same"]);
  });

  it("hands back the message exactly as it was sent", () => {
    // The send path passes the composer's raw value through, so deliberate
    // indentation is part of the prompt. Recall must not tidy it.
    const indented = "  def main():\n      return 1\n";
    expect(collectInputHistory([userMessage(indented)])).toEqual([indented]);
  });

  it("survives a thread that has not loaded", () => {
    expect(collectInputHistory(undefined)).toEqual([]);
    expect(collectInputHistory(null)).toEqual([]);
  });
});

describe("navigateInputHistory", () => {
  const entries = ["newest", "middle", "oldest"];

  it("recalls the most recent message on the first press", () => {
    const result = navigateInputHistory({
      direction: "older",
      entries,
      value: "",
      navigation: null,
    });
    expect(result?.value).toBe("newest");
    expect(result?.navigation).toEqual({
      index: 0,
      draft: "",
      applied: "newest",
    });
  });

  it("keeps walking backwards, then stays put at the oldest", () => {
    let navigation: InputHistoryNavigation | null = null;
    let value = "";
    for (const expected of ["newest", "middle", "oldest"]) {
      const step = navigateInputHistory({
        direction: "older",
        entries,
        value,
        navigation,
      });
      navigation = step!.navigation;
      value = step!.value;
      expect(value).toBe(expected);
    }

    // One press past the end: consumed (so the caret does not jump somewhere
    // unrelated) but nothing moves.
    const past = navigateInputHistory({
      direction: "older",
      entries,
      value,
      navigation,
    });
    expect(past).not.toBeNull();
    expect(past!.value).toBe("oldest");
    expect(past!.navigation?.index).toBe(2);
  });

  it("hands back the half-written draft at the newest end", () => {
    const up = navigateInputHistory({
      direction: "older",
      entries,
      value: "half written",
      navigation: null,
    })!;
    expect(up.value).toBe("newest");

    const down = navigateInputHistory({
      direction: "newer",
      entries,
      value: up.value,
      navigation: up.navigation,
    })!;
    expect(down.value).toBe("half written");
    expect(down.navigation).toBeNull();
  });

  it("carries the draft across a walk of several steps", () => {
    let step = navigateInputHistory({
      direction: "older",
      entries,
      value: "draft",
      navigation: null,
    })!;
    step = navigateInputHistory({
      direction: "older",
      entries,
      value: step.value,
      navigation: step.navigation,
    })!;
    expect(step.value).toBe("middle");

    step = navigateInputHistory({
      direction: "newer",
      entries,
      value: step.value,
      navigation: step.navigation,
    })!;
    expect(step.value).toBe("newest");
    step = navigateInputHistory({
      direction: "newer",
      entries,
      value: step.value,
      navigation: step.navigation,
    })!;
    expect(step.value).toBe("draft");
  });

  it("ends the walk once the recalled text has been edited", () => {
    const up = navigateInputHistory({
      direction: "older",
      entries,
      value: "",
      navigation: null,
    })!;

    // The user typed over the recall. The next Up starts again from the top
    // and treats what they wrote as the draft to come back to.
    const afterEdit = navigateInputHistory({
      direction: "older",
      entries,
      value: "newest, but edited",
      navigation: up.navigation,
    })!;
    expect(afterEdit.value).toBe("newest");
    expect(afterEdit.navigation?.draft).toBe("newest, but edited");
  });

  it("restarts the walk when the thread underneath it is replaced", () => {
    // Opening another session from the history rail swaps every entry while
    // the composer keeps whatever it was holding. Counting on from the old
    // index would skip the new thread's most recent message.
    const walk = navigateInputHistory({
      direction: "older",
      entries,
      value: "",
      navigation: null,
    })!;
    expect(walk.value).toBe("newest");

    const otherThread = ["a different thread", "and its older message"];
    const afterSwap = navigateInputHistory({
      direction: "older",
      entries: otherThread,
      value: walk.value,
      navigation: walk.navigation,
    })!;

    expect(afterSwap.value).toBe("a different thread");
    expect(afterSwap.navigation?.index).toBe(0);
  });

  it("leaves the key alone when there is nothing to recall", () => {
    expect(
      navigateInputHistory({
        direction: "older",
        entries: [],
        value: "typing",
        navigation: null,
      }),
    ).toBeNull();
  });

  it("leaves Down alone outside a walk — that key belongs to the caret", () => {
    expect(
      navigateInputHistory({
        direction: "newer",
        entries,
        value: "typing",
        navigation: null,
      }),
    ).toBeNull();
  });
});

describe("caret edges", () => {
  it("treats a single-line draft as both first and last line", () => {
    expect(caretIsOnFirstLine("hello", 5)).toBe(true);
    expect(caretIsOnLastLine("hello", 5)).toBe(true);
  });

  it("keeps the arrows inside a multi-line draft", () => {
    const value = "one\ntwo\nthree";
    const onSecondLine = 5;
    expect(caretIsOnFirstLine(value, onSecondLine)).toBe(false);
    expect(caretIsOnLastLine(value, onSecondLine)).toBe(false);
  });

  it("releases the arrows at the top and the bottom", () => {
    const value = "one\ntwo";
    expect(caretIsOnFirstLine(value, 1)).toBe(true);
    expect(caretIsOnLastLine(value, 1)).toBe(false);
    expect(caretIsOnFirstLine(value, value.length)).toBe(false);
    expect(caretIsOnLastLine(value, value.length)).toBe(true);
  });
});
