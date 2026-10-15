import type { StreamEvent } from "./types";

export type ProviderName = "openai" | "anthropic" | "gemini" | "groq" | "generic" | "auto";

export interface ProviderAdapter {
  readonly name: string;
  /** Map one decoded wire payload to zero or more normalized events */
  mapPayload(payload: Record<string, unknown>): StreamEvent[];
  /** Per-payload done signal (provider-specific in-band completion) */
  isDone?(payload: Record<string, unknown>): boolean;
  /**
   * Tool finalization scope requested by the last payload:
   * "all" | slot indices | null (pipeline-side, see base hook).
   */
  takeFinalize(): "all" | number[] | null;
  finalize(): StreamEvent[];
}

function delta(text: string): StreamEvent {
  return { type: "delta", text };
}
function reasoning(text: string): StreamEvent {
  return { type: "reasoning_delta", text };
}
function metadata(
  provider: string,
  model?: string,
  finish_reason?: string,
): StreamEvent {
  return { type: "metadata", provider, model, finish_reason };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === "string";
}

// OpenAI

export class OpenAIAdapter implements ProviderAdapter {
  readonly name: string;
  private _model: string | null = null;
  private _finalizeNow: "all" | number[] | null = null;

  constructor(provider = "openai") {
    this.name = provider;
  }

  mapPayload(payload: Record<string, unknown>): StreamEvent[] {
    const events: StreamEvent[] = [];
    if (isStr(payload.model) && this._model === null) this._model = payload.model;

    const choices = payload.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const c0 = choices[0];
      if (isObj(c0)) {
        const d = isObj(c0.delta) ? c0.delta : {};
        if (isStr(d.content) && d.content) events.push(delta(d.content));
        // Some OpenAI-compatible proxies (e.g. one-api) emit the thinking
        // text under "reasoning" instead of the standard "reasoning_content";
        // accept both.
        const reasoningText =
          isStr(d.reasoning_content) && d.reasoning_content ? d.reasoning_content
          : isStr(d.reasoning) && d.reasoning ? d.reasoning
          : null;
        if (reasoningText) events.push(reasoning(reasoningText));
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            if (!isObj(tc)) continue;
            const ev: StreamEvent = { type: "tool_call_delta", index: Number(tc.index ?? 0) };
            if (tc.id !== undefined && tc.id !== null) ev.id = String(tc.id);
            const fn = isObj(tc.function) ? tc.function : {};
            if (isStr(fn.name) && fn.name) ev.name = fn.name;
            if (isStr(fn.arguments) && fn.arguments) ev.arguments_delta = fn.arguments;
            events.push(ev);
          }
        }
        const finish = c0.finish_reason;
        if (isStr(finish) && finish) {
          events.push(metadata(this.name, this._model ?? undefined, finish));
          if (finish === "tool_calls") this._finalizeNow = "all";
        }
      }
    }

    const usage = payload.usage;
    if (isObj(usage)) {
      events.push({
        type: "usage",
        input_tokens: num(usage.prompt_tokens),
        output_tokens: num(usage.completion_tokens),
        total_tokens: num(usage.total_tokens),
      });
    }
    const xGroq = payload.x_groq;
    if (isObj(xGroq) && isObj(xGroq.usage)) {
      const u = xGroq.usage;
      events.push({
        type: "usage",
        input_tokens: num(u.prompt_tokens),
        output_tokens: num(u.completion_tokens),
        total_tokens: num(u.total_tokens),
      });
    }
    return events;
  }

  takeFinalize(): "all" | number[] | null {
    const s = this._finalizeNow;
    this._finalizeNow = null;
    return s;
  }

  finalize(): StreamEvent[] {
    return [];
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

export class GroqAdapter extends OpenAIAdapter {
  constructor() {
    super("groq");
  }
}

// Anthropic

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";
  private _blockTypes = new Map<number, string>();
  private _blockIds = new Map<number, string>();
  private _blockNames = new Map<number, string>();
  private _nameSent = new Set<number>();
  private _model: string | null = null;
  private _finalizeNow: "all" | number[] | null = null;

  mapPayload(payload: Record<string, unknown>): StreamEvent[] {
    const t = payload.type;
    if (t === "message_start") {
      const msg = isObj(payload.message) ? payload.message : {};
      if (isStr(msg.model)) {
        this._model = msg.model;
        return [metadata(this.name, msg.model)];
      }
      return [];
    }
    if (t === "content_block_start") {
      const idx = Number(payload.index ?? 0);
      const block = isObj(payload.content_block) ? payload.content_block : {};
      this._blockTypes.set(idx, isStr(block.type) ? block.type : "");
      if (block.id !== undefined && block.id !== null)
        this._blockIds.set(idx, String(block.id));
      if (isStr(block.name) && block.name) this._blockNames.set(idx, block.name);
      return [];
    }
    if (t === "content_block_delta") {
      const idx = Number(payload.index ?? 0);
      const d = isObj(payload.delta) ? payload.delta : {};
      const dtype = d.type;
      if (dtype === "text_delta") {
        if (isStr(d.text) && d.text) return [delta(d.text)];
      } else if (dtype === "thinking_delta") {
        if (isStr(d.thinking) && d.thinking) return [reasoning(d.thinking)];
      } else if (dtype === "input_json_delta") {
        if (isStr(d.partial_json) && d.partial_json) {
          const ev: StreamEvent = { type: "tool_call_delta", index: idx };
          const id = this._blockIds.get(idx);
          if (id !== undefined) ev.id = id;
          // name arrives once at content_block_start, don't repeat it on
          // every fragment (parser concatenates name fragments)
          const nm = this._blockNames.get(idx);
          if (nm !== undefined && !this._nameSent.has(idx)) {
            ev.name = nm;
            this._nameSent.add(idx);
          }
          ev.arguments_delta = d.partial_json;
          return [ev];
        }
      }
      return [];
    }
    if (t === "content_block_stop") {
      const idx = Number(payload.index ?? 0);
      if (this._blockTypes.get(idx) === "tool_use") this._finalizeNow = [idx];
      return [];
    }
    if (t === "message_delta") {
      const events: StreamEvent[] = [];
      const usage = payload.usage;
      if (isObj(usage)) {
        events.push({
          type: "usage",
          input_tokens: num(usage.input_tokens),
          output_tokens: num(usage.output_tokens),
        });
      }
      const d = isObj(payload.delta) ? payload.delta : {};
      const stop = d.stop_reason;
      if (isStr(stop) && stop) events.push(metadata(this.name, this._model ?? undefined, stop));
      return events;
    }
    if (t === "error") {
      const err = isObj(payload.error) ? payload.error : {};
      return [
        {
          type: "error",
          code: isStr(err.type) ? err.type : "provider_error",
          message: isStr(err.message) ? err.message : "",
          provider_error: payload,
        },
      ];
    }
    return [];
  }

  isDone(payload: Record<string, unknown>): boolean {
    return payload.type === "message_stop";
  }

  takeFinalize(): "all" | number[] | null {
    const s = this._finalizeNow;
    this._finalizeNow = null;
    return s;
  }

  finalize(): StreamEvent[] {
    return [];
  }
}

// Gemini

export class GeminiAdapter implements ProviderAdapter {
  readonly name = "gemini";
  private _model: string | null = null;
  private _finishEmitted = false;
  private _nextToolIndex = 0;

  mapPayload(payload: Record<string, unknown>): StreamEvent[] {
    const events: StreamEvent[] = [];
    if (isStr(payload.modelVersion) && this._model === null)
      this._model = payload.modelVersion;

    const candidates = payload.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const c0 = candidates[0];
      if (isObj(c0)) {
        const content = isObj(c0.content) ? c0.content : {};
        const parts = Array.isArray(content.parts) ? content.parts : [];
        for (const part of parts) {
          if (!isObj(part)) continue;
          if (isStr(part.text) && part.text) {
            events.push(part.thought === true ? reasoning(part.text) : delta(part.text));
          }
          const fc = part.functionCall;
          if (isObj(fc) && isStr(fc.name) && fc.name) {
            events.push({
              type: "tool_call_delta",
              index: this._nextToolIndex,
              name: fc.name,
              arguments_delta:
                fc.args !== undefined && fc.args !== null
                  ? JSON.stringify(fc.args)
                  : "",
            });
            this._nextToolIndex += 1;
          }
        }
        const finish = c0.finishReason;
        if (isStr(finish) && finish && !this._finishEmitted) {
          this._finishEmitted = true;
          events.push(metadata(this.name, this._model ?? undefined, finish));
        }
      }
    }

    const usage = payload.usageMetadata;
    if (isObj(usage)) {
      events.push({
        type: "usage",
        input_tokens: num(usage.promptTokenCount),
        output_tokens: num(usage.candidatesTokenCount),
        total_tokens: num(usage.totalTokenCount),
      });
    }
    return events;
  }

  isDone(payload: Record<string, unknown>): boolean {
    const candidates = payload.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const c0 = candidates[0];
      if (isObj(c0) && isStr(c0.finishReason)) return true;
    }
    return false;
  }

  takeFinalize(): "all" | number[] | null {
    return null;
  }

  finalize(): StreamEvent[] {
    return [];
  }
}

// Generic fallback

export const DEFAULT_TEXT_PATHS: string[] = [
  "choices.0.delta.content",
  "delta.text",
  "candidates.0.content.parts.0.text",
  "message.content",
  "response",
  "text",
  "output",
  "completion",
];

const DEFAULT_TOOL_PATH = "tool";

/** Dotted path lookup (int segments index arrays) */
export function resolvePath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (isObj(cur)) {
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

export class GenericAdapter implements ProviderAdapter {
  readonly name = "generic";
  private _textPath: string | null;
  private _toolPath: string | null;
  private _resolvedTextPath: string | null = null;
  private _nextToolIndex = 0;
  private _model: string | null = null;
  private _finishReason: string | null = null;

  constructor(textPath?: string, toolPath?: string) {
    this._textPath = textPath ?? null;
    this._toolPath = toolPath ?? null;
  }

  mapPayload(payload: Record<string, unknown>): StreamEvent[] {
    const events: StreamEvent[] = [];
    if (isStr(payload.model) && this._model === null) this._model = payload.model;

    // Error payloads
    if ("error" in payload && !("choices" in payload) && !("candidates" in payload)) {
      const err = payload.error;
      if (isObj(err)) {
        return [
          {
            type: "error",
            code: isStr(err.type) && err.type ? err.type : isStr(err.code) && err.code ? err.code : "provider_error",
            message: isStr(err.message) ? err.message : "",
            provider_error: payload,
          },
        ];
      }
      return [
        { type: "error", code: "provider_error", message: String(err), provider_error: payload },
      ];
    }

    // Text
    const paths = this._textPath ? [this._textPath] : DEFAULT_TEXT_PATHS;
    let text: string | null = null;
    for (const p of paths) {
      const v = resolvePath(payload, p);
      if (isStr(v) && v) {
        text = v;
        if (this._resolvedTextPath === null) this._resolvedTextPath = p;
        break;
      }
    }
    if (text) events.push(delta(text));

    // Optional tool fragments
    const toolPath = this._toolPath ?? DEFAULT_TOOL_PATH;
    const tool = resolvePath(payload, toolPath);
    if (isObj(tool) && (tool.name || tool.arguments !== undefined)) {
      const args = tool.arguments;
      events.push({
        type: "tool_call_delta",
        index: this._nextToolIndex,
        name: isStr(tool.name) ? tool.name : "",
        arguments_delta: isStr(args) ? args : args !== undefined && args !== null ? JSON.stringify(args) : "",
      });
      this._nextToolIndex += 1;
    }

    // Done flags and finish reasons
    const fr = payload.finish_reason ?? payload.finishReason;
    if (isStr(fr) && fr && !this._finishReason) this._finishReason = fr;
    if (payload.done === true || fr) {
      events.push(
        metadata("generic", this._model ?? undefined, isStr(fr) ? fr : "stop"),
      );
    }
    return events;
  }

  isDone(payload: Record<string, unknown>): boolean {
    return payload.done === true;
  }

  takeFinalize(): "all" | number[] | null {
    return null;
  }

  finalize(): StreamEvent[] {
    return [];
  }
}

// Detection + registry

const ANTHROPIC_TYPES = new Set([
  "message_start", "message_delta", "message_stop",
  "content_block_start", "content_block_delta", "content_block_stop",
  "ping",
]);

/** Normative detection order */
export function detectProvider(payload: unknown): Exclude<ProviderName, "auto"> {
  if (!isObj(payload)) return "generic";
  if (payload.candidates !== undefined && Array.isArray(payload.candidates))
    return "gemini";
  const t = payload.type;
  if (isStr(t) && ANTHROPIC_TYPES.has(t)) return "anthropic";
  if (t === "error" && "error" in payload) return "anthropic";
  if ("x_groq" in payload) return "groq";
  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const c0 = isObj(choices[0]) ? choices[0] : {};
    if ("delta" in c0 || payload.object === "chat.completion.chunk")
      return "openai";
  }
  return "generic";
}

export const PROVIDERS = {
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter,
  gemini: GeminiAdapter,
  groq: GroqAdapter,
  generic: GenericAdapter,
} as const;

export function createAdapter(
  provider: ProviderName = "auto",
  opts?: { textPath?: string; toolPath?: string },
): ProviderAdapter {
  if (provider === "auto")
    return new GenericAdapter(opts?.textPath, opts?.toolPath);
  const Cls = (PROVIDERS as Record<string, new (...a: never[]) => ProviderAdapter>)[provider];
  if (!Cls) throw new Error(`unknown provider: ${provider}`);
  if (provider === "generic") return new GenericAdapter(opts?.textPath, opts?.toolPath);
  if (provider === "groq") return new GroqAdapter();
  return new (Cls as new () => ProviderAdapter)();
}