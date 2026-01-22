/**
 * Validators for matching tool calls in eval tests
 *
 * All matching is case-sensitive and uses exact strings only (no wildcards).
 */

import type { ToolCall } from "./types.js";

/**
 * Exact match - all expected tools must be present in exact order.
 * Case-sensitive exact string comparison.
 *
 * @param expected - The expected tool names in order
 * @param actual - The actual tool names that were called
 * @returns true if actual matches expected exactly
 *
 * @example
 * matchToolCalls(['add', 'multiply'], ['add', 'multiply']) // true
 * matchToolCalls(['add', 'multiply'], ['multiply', 'add']) // false (wrong order)
 * matchToolCalls(['add'], ['add', 'multiply']) // false (extra tool)
 */
export function matchToolCalls(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) {
    return false;
  }

  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Subset match - all expected tools must be present, order doesn't matter.
 * Case-sensitive exact string comparison.
 *
 * @param expected - The expected tool names (any order)
 * @param actual - The actual tool names that were called
 * @returns true if all expected tools are present in actual
 *
 * @example
 * matchToolCallsSubset(['add', 'multiply'], ['multiply', 'add']) // true
 * matchToolCallsSubset(['add'], ['add', 'multiply']) // true
 * matchToolCallsSubset(['add', 'subtract'], ['add', 'multiply']) // false (missing subtract)
 */
export function matchToolCallsSubset(
  expected: string[],
  actual: string[]
): boolean {
  for (const tool of expected) {
    if (!actual.includes(tool)) {
      return false;
    }
  }

  return true;
}

/**
 * Any match - at least one expected tool must be present.
 * Case-sensitive exact string comparison.
 *
 * @param expected - The expected tool names (at least one must match)
 * @param actual - The actual tool names that were called
 * @returns true if at least one expected tool is present in actual
 *
 * @example
 * matchAnyToolCall(['add', 'subtract'], ['multiply', 'add']) // true
 * matchAnyToolCall(['add', 'subtract'], ['multiply', 'divide']) // false
 * matchAnyToolCall([], ['add']) // false (empty expected)
 */
export function matchAnyToolCall(
  expected: string[],
  actual: string[]
): boolean {
  if (expected.length === 0) {
    return false;
  }

  for (const tool of expected) {
    if (actual.includes(tool)) {
      return true;
    }
  }

  return false;
}

/**
 * Count match - check if a specific tool was called exactly N times.
 * Case-sensitive exact string comparison.
 *
 * @param toolName - The tool name to count
 * @param actual - The actual tool names that were called
 * @param count - The expected number of times the tool should be called
 * @returns true if the tool was called exactly count times
 *
 * @example
 * matchToolCallCount('add', ['add', 'add', 'multiply'], 2) // true
 * matchToolCallCount('add', ['add', 'multiply'], 2) // false
 */
export function matchToolCallCount(
  toolName: string,
  actual: string[],
  count: number
): boolean {
  const actualCount = actual.filter((t) => t === toolName).length;
  return actualCount === count;
}

/**
 * No tools match - check that no tools were called.
 *
 * @param actual - The actual tool names that were called
 * @returns true if no tools were called
 *
 * @example
 * matchNoToolCalls([]) // true
 * matchNoToolCalls(['add']) // false
 */
export function matchNoToolCalls(actual: string[]): boolean {
  return actual.length === 0;
}

// === Argument-based validators (Phase 2.5) ===

/**
 * Deep equality check that is key-order independent for objects.
 * Handles objects, arrays, and primitives.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  // Handle primitives and null
  if (a === b) {
    return true;
  }

  // Handle null/undefined cases
  if (a === null || b === null || a === undefined || b === undefined) {
    return false;
  }

  // Handle different types
  if (typeof a !== typeof b) {
    return false;
  }

  // Handle arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  // Handle array vs non-array mismatch
  if (Array.isArray(a) || Array.isArray(b)) {
    return false;
  }

  // Handle objects (key-order independent)
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);

    if (aKeys.length !== bKeys.length) {
      return false;
    }

    for (const key of aKeys) {
      if (
        !Object.prototype.hasOwnProperty.call(b, key) ||
        !deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key]
        )
      ) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Check if tool was called with exact arguments (deep equality).
 * Returns true if any call to the tool has exactly matching arguments.
 * Case-sensitive for tool names.
 *
 * @param toolName - The tool name to match
 * @param expectedArgs - The expected arguments (exact match)
 * @param toolCalls - The actual tool calls made
 * @returns true if any call to the tool has exactly matching arguments
 *
 * @example
 * matchToolCallWithArgs('add', {a: 2, b: 3}, toolCalls) // true if add({a:2, b:3}) was called
 * matchToolCallWithArgs('add', {a: 2}, [{toolName:'add', arguments:{a:2, b:3}}]) // false (extra arg)
 */
export function matchToolCallWithArgs(
  toolName: string,
  expectedArgs: Record<string, unknown>,
  toolCalls: ToolCall[]
): boolean {
  for (const call of toolCalls) {
    if (call.toolName === toolName && deepEqual(call.arguments, expectedArgs)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if tool was called with at least these arguments (partial match).
 * Allows extra arguments in the actual call.
 * Case-sensitive for tool names.
 *
 * @param toolName - The tool name to match
 * @param expectedArgs - The expected arguments (partial match)
 * @param toolCalls - The actual tool calls made
 * @returns true if any call to the tool contains all expected arguments
 *
 * @example
 * matchToolCallWithPartialArgs('add', {a: 2}, [{toolName:'add', arguments:{a:2, b:3}}]) // true
 * matchToolCallWithPartialArgs('add', {a: 2, c: 5}, [{toolName:'add', arguments:{a:2, b:3}}]) // false
 */
export function matchToolCallWithPartialArgs(
  toolName: string,
  expectedArgs: Record<string, unknown>,
  toolCalls: ToolCall[]
): boolean {
  for (const call of toolCalls) {
    if (call.toolName !== toolName) {
      continue;
    }

    let allMatch = true;
    for (const [key, expectedValue] of Object.entries(expectedArgs)) {
      if (
        !(key in call.arguments) ||
        !deepEqual(call.arguments[key], expectedValue)
      ) {
        allMatch = false;
        break;
      }
    }

    if (allMatch) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a specific argument has a specific value in any call to the tool.
 * Case-sensitive for tool names.
 *
 * @param toolName - The tool name to match
 * @param argKey - The argument key to check
 * @param expectedValue - The expected value for the argument
 * @param toolCalls - The actual tool calls made
 * @returns true if any call to the tool has the specified argument value
 *
 * @example
 * matchToolArgument('add', 'a', 2, toolCalls) // true if any add() call had a=2
 */
export function matchToolArgument(
  toolName: string,
  argKey: string,
  expectedValue: unknown,
  toolCalls: ToolCall[]
): boolean {
  for (const call of toolCalls) {
    if (
      call.toolName === toolName &&
      argKey in call.arguments &&
      deepEqual(call.arguments[argKey], expectedValue)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check if argument value matches a predicate function.
 * Useful for partial matches, type checks, or range validation.
 * Case-sensitive for tool names.
 *
 * @param toolName - The tool name to match
 * @param argKey - The argument key to check
 * @param predicate - Function that tests the argument value
 * @param toolCalls - The actual tool calls made
 * @returns true if any call to the tool has an argument value that passes the predicate
 *
 * @example
 * matchToolArgumentWith('echo', 'message', (v) => typeof v === 'string' && v.includes('hello'), toolCalls)
 * matchToolArgumentWith('add', 'a', (v) => typeof v === 'number' && v > 0, toolCalls)
 */
export function matchToolArgumentWith(
  toolName: string,
  argKey: string,
  predicate: (value: unknown) => boolean,
  toolCalls: ToolCall[]
): boolean {
  for (const call of toolCalls) {
    if (call.toolName === toolName && argKey in call.arguments) {
      if (predicate(call.arguments[argKey])) {
        return true;
      }
    }
  }
  return false;
}
