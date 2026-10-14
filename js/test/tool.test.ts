import { describe, expect, it } from "vitest";
import { StreamingToolParser } from "../src/index";
import { loadVectors } from "./vectors";

function feed(parser: StreamingToolParser, slot: Record<string, unknown>) {
  const index = (slot.index as number) ?? 0;
  for (const frag of (slot.name_fragments as string[]) ?? [])
    parser.onToolCallDelta({ type: "tool_call_delta", index, name: frag });
  for (const frag of (slot.argument_fragments as string[]) ?? [])
    parser.onToolCallDelta({ type: "tool_call_delta", index, arguments_delta: frag });
}

function match(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): boolean {
  for (const [k, v] of Object.entries(expected)) {
    if (k === "type") {
      if (actual.type !== v) return false;
      continue;
    }
    if (!(k in actual) || actual[k] !== v) {
      // deep compare for arguments
      if (k === "arguments") {
        const a = JSON.stringify(actual[k]);
        const b = JSON.stringify(v);
        if (a !== b) return false;
        continue;
      }
      return false;
    }
  }
  return true;
}

const vectors = loadVectors("tool");

describe.each(vectors)("$name", (vec) => {
  it("fragments → complete", () => {
    const parser = new StreamingToolParser();
    const input = vec.input as Record<string, unknown>;
    if ("slots" in input) for (const s of input.slots as Record<string, unknown>[]) feed(parser, s);
    else feed(parser, input);
    const events = parser.finalize() as unknown as Record<string, unknown>[];

    const expected = vec.expected as
      | Record<string, unknown>
      | Record<string, unknown>[];
    if (Array.isArray(expected)) {
      expect(events.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++)
        expect(match(expected[i], events[i]), `event #${i}`).toBe(true);
    } else {
      expect(events.length).toBe(1);
      expect(match(expected, events[0])).toBe(true);
    }
  });
});