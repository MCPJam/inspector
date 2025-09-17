import { GenerateTextResult, ModelMessage, ToolSet } from "ai";
import { extractToolNamesAsArray } from "../utils/helpers";

export const evaluateResults = (
  messages: ModelMessage[],
  expectedToolCalls: string[],
  toolsCalled: string[],
) => {
  console.log("Expected tool calls: ", expectedToolCalls);
  console.log("Tools called: ", toolsCalled);
  console.log("Messages: ", messages);
  if (expectedToolCalls.length > 0) {
    if (expectedToolCalls.length !== toolsCalled.length) {
      console.log("Expected tool calls and tools called do not match");
    }
    for (const expectedToolCall of expectedToolCalls) {
      if (!toolsCalled.includes(expectedToolCall)) {
        console.log("Expected tool call not found: ", expectedToolCall);
      }
    }
  }
};
