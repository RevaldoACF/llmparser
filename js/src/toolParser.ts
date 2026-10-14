import type { StreamEvent } from "./types";

export interface ToolSlot {
  index: number;
  id?: string;
  name: string;
  args: string;
  finalized: boolean;
}

export class StreamingToolParser {
  private slots = new Map<number, ToolSlot>();

  reset(): void {
    this.slots.clear();
  }

  /** Read-only snapshot of slots (for debugging) */
  get slotList(): ToolSlot[] {
    return [...this.slots.values()];
  }

  // -- event handling

  onToolCallDelta(
    ev: StreamEvent,
    onProgress?: (index: number, partial: unknown) => void,
  ): void {
    const index = ev.index ?? 0;
    let slot = this.slots.get(index);
    if (!slot) {
      slot = { index, name: "", args: "", finalized: false };
      this.slots.set(index, slot);
    }
    if (slot.finalized) return; // late fragment: ignore (idempotent finalize)
    if (ev.id !== undefined && ev.id !== null) slot.id = ev.id;
    if (ev.name) slot.name += ev.name;
    if (ev.arguments_delta) slot.args += ev.arguments_delta;
    if (onProgress) onProgress(index, partialJson(slot.args));
  }

  finalize(indices?: number[]): StreamEvent[] {
    const out: StreamEvent[] = [];
    const keys = [...this.slots.keys()].sort((a, b) => a - b);
    for (const index of keys) {
      if (indices && !indices.includes(index)) continue;
      const slot = this.slots.get(index)!;
      if (slot.finalized) continue;
      slot.finalized = true;
      if (slot.name === "" && slot.args === "") continue; // phantom empty
      if (slot.args === "") {
        out.push({
          type: "tool_call_complete",
          index,
          id: slot.id,
          name: slot.name,
          arguments: {},
          raw_arguments: "",
        });
        continue;
      }
      let obj: unknown;
      try {
        obj = JSON.parse(slot.args);
        if (typeof obj !== "object" || obj === null || Array.isArray(obj))
          throw new Error("expected a JSON object");
      } catch (e) {
        out.push({
          type: "error",
          code: "tool_arguments_invalid",
          message: `invalid tool arguments for '${slot.name}': ${
            e instanceof Error ? e.message : String(e)
          }`
            .trim(),
          raw_arguments: slot.args,
          index,
        });
        continue;
      }
      out.push({
        type: "tool_call_complete",
        index,
        id: slot.id,
        name: slot.name,
        arguments: obj as Record<string, unknown>,
        raw_arguments: slot.args,
      });
    }
    return out;
  }
}

// partialJson
// Display-only. NEVER gates dispatch

export function partialJson(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // fall through to completion
  }

  let inString = false;
  let escape = false;
  const stack: string[] = [];
  for (const ch of s) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}") {
      if (stack.length && stack[stack.length - 1] === "{") stack.pop();
    } else if (ch === "]") {
      if (stack.length && stack[stack.length - 1] === "[") stack.pop();
    }
  }

  let fixups = "";
  if (inString) fixups += '"';
  // trim dangling comma / colon
  let t = s.replace(/\s+$/, "");
  if (t.endsWith(",")) t = t.slice(0, -1);
  else if (t.endsWith(":")) fixups = "null" + fixups; // colon kept
  const closers = [...stack].reverse().map((b) => (b === "{" ? "}" : "]")).join("");
  const candidate = t + fixups + closers;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}