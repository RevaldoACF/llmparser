import { SentenceBuffer } from "./buffer";
import { type Chunk, JsonLinesDecoder, SSEDecoder } from "./decoders";
import {
  LLMStreamError,
  ProtocolError,
  ProviderError,
  ToolArgumentsError,
} from "./errors";
import {
  type ProviderName,
  createAdapter,
  detectProvider,
  type ProviderAdapter,
} from "./providers";
import { StreamingToolParser } from "./toolParser";
import {
  type BufferLike,
  type OnError,
  resolveBuffer,
  type StreamEvent,
} from "./types";

export type StreamFormat = "auto" | "sse" | "jsonl";

export interface PipelineOptions {
  /** Provider name or "auto" (default) */
  provider?: ProviderName;
  /** Buffer config for parseStream. @default "voice" */
  buffer?: BufferLike;
  /** Wire format. @default "auto" */
  streamFormat?: StreamFormat;
  /** Error policy. @default "raise" */
  on_error?: OnError;
  /** Generic-adapter text and tool path override */
  textPath?: string;
  toolPath?: string;
}

/** Anything parseStream/parseEvents can consume */
export type ChunkSource =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Chunk | Record<string, unknown>>
  | Iterable<Chunk | Record<string, unknown>>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Uint8Array)
  );
}

function toUint8Array(chunk: Chunk): Uint8Array {
  return typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
}

// ParserCore — single source of truth (mirrors Python ParserCore)

export class ParserCore {
  private toolParser = new StreamingToolParser();
  private adapter: ProviderAdapter | null;
  private sse: SSEDecoder | null = null;
  private jsonl: JsonLinesDecoder | null = null;
  private preParsed: boolean | null = null;
  private rawHistory: Chunk[] = [];
  private sseProduced = false;
  private closed = false;
  readonly on_error: OnError;

  constructor(
    provider: ProviderName = "auto",
    streamFormat: StreamFormat = "auto",
    on_error: OnError = "raise",
    textPath?: string,
    toolPath?: string,
  ) {
    if (on_error !== "raise" && on_error !== "skip")
      throw new Error("on_error must be 'raise' or 'skip'");
    this.on_error = on_error;
    this.adapter =
      provider === "auto" ? null : createAdapter(provider, { textPath, toolPath });
    if (streamFormat === "jsonl") this.jsonl = new JsonLinesDecoder();
    else if (streamFormat !== "sse") this.sse = new SSEDecoder();
  }

  private payloadEvents(payload: Record<string, unknown>): StreamEvent[] {
    if (this.adapter === null)
      this.adapter = createAdapter(detectProvider(payload));
    const out: StreamEvent[] = [];
    for (const ev of this.adapter.mapPayload(payload)) {
      if (ev.type === "tool_call_delta") this.toolParser.onToolCallDelta(ev);
      out.push(ev);
    }
    const scope = this.adapter.takeFinalize();
    if (scope === "all") out.push(...this.toolParser.finalize());
    else if (scope) out.push(...this.toolParser.finalize(scope));
    return out;
  }

  private lineEvents(line: string): StreamEvent[] {
    if (line.trim() === "[DONE]") return [];
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch (e) {
      const ev: StreamEvent = {
        type: "error",
        code: "malformed_chunk",
        message: e instanceof Error ? e.message : String(e),
        raw: { raw: line },
      };
      raiseIfError(ev, this.on_error);
      return [ev];
    }
    if (!isPlainObject(payload)) return [];
    return this.payloadEvents(payload);
  }

  /** Feed one chunk, returns zero or more events */
  feed(chunk: Chunk | Record<string, unknown>): StreamEvent[] {
    if (isPlainObject(chunk)) {
      if (this.preParsed === false && this.sse !== null)
        throw new LLMStreamError("mixing raw and pre-parsed chunks");
      this.preParsed = true;
      return this.payloadEvents(chunk);
    }
    if (this.preParsed === true)
      throw new LLMStreamError("mixing raw and pre-parsed chunks");
    this.preParsed = false;
    if (this.jsonl) {
      this.sseProduced = true;
      return this.jsonl
        .feed(toUint8Array(chunk as Chunk))
        .flatMap((l) => this.lineEvents(l));
    }
    if (this.sse) {
      const records = this.sse.feed(toUint8Array(chunk as Chunk));
      if (records.length > 0) {
        this.sseProduced = true;
        this.rawHistory = []; // no fallback needed anymore
      } else if (!this.sseProduced) {
        this.rawHistory.push(chunk as Chunk); // auto-fallback retention
      }
      return records.map((r) => r.data).flatMap((d) => this.lineEvents(d));
    }
    throw new LLMStreamError("no decoder available");
  }

  /** flush decoder tail, tool finalize, `done` */
  close(): StreamEvent[] {
    if (this.closed) return [];
    this.closed = true;
    const out: StreamEvent[] = [];
    if (this.jsonl) {
      const tail = this.jsonl.close();
      if (tail) out.push(...this.lineEvents(tail));
    } else if (this.sse) {
      const tail = this.sse.close();
      if (tail) out.push(...this.lineEvents(tail.data));
    }
    // SSE->JSONL auto fallback
    if (this.sse && !this.sseProduced && this.rawHistory.length > 0) {
      const jsonl = new JsonLinesDecoder();
      for (const chunk of this.rawHistory)
        out.push(...jsonl.feed(toUint8Array(chunk)).flatMap((l) => this.lineEvents(l)));
      const tail = jsonl.close();
      if (tail) out.push(...this.lineEvents(tail));
    }
    this.rawHistory = [];
    out.push(...this.toolParser.finalize());
    if (this.adapter) out.push(...this.adapter.finalize());
    out.push({ type: "done" });
    return out;
  }
}

function raiseIfError(ev: StreamEvent, on_error: OnError): void {
  if (ev.type !== "error" || on_error !== "raise") return;
  if (ev.code === "tool_arguments_invalid")
    throw new ToolArgumentsError("", ev.raw_arguments ?? "", ev.message ?? "");
  if (ev.code === "malformed_chunk") {
    const raw = ev.raw?.raw;
    throw new ProtocolError(ev.message ?? "", typeof raw === "string" ? raw : "");
  }
  throw new ProviderError(
    ev.code ?? "provider_error",
    ev.message ?? "",
    ev.provider_error,
  );
}

// Source normalization

async function* sourceIterator(
  source: ChunkSource,
): AsyncGenerator<Chunk | Record<string, unknown>> {
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  } else if (typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    for await (const chunk of source as AsyncIterable<Chunk | Record<string, unknown>>)
      yield chunk;
  } else {
    for (const chunk of source as Iterable<Chunk | Record<string, unknown>>) yield chunk;
  }
}

// Event iterator

/** chunks → AsyncIterable<StreamEvent> (includes final `done`). */
export async function* parseEvents(
  chunks: ChunkSource,
  opts: PipelineOptions = {},
): AsyncGenerator<StreamEvent, void, unknown> {
  const core = new ParserCore(
    opts.provider ?? "auto",
    opts.streamFormat ?? "auto",
    opts.on_error ?? "raise",
    opts.textPath,
    opts.toolPath,
  );
  for await (const chunk of sourceIterator(chunks)) {
    for (const ev of core.feed(chunk)) yield ev;
  }
  for (const ev of core.close()) yield ev;
}

// Sentence pipeline (parseStream)

const TIMEOUT = Symbol("llmstream.idle-timeout");

function raceWithTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | typeof TIMEOUT> {
  return new Promise<T | typeof TIMEOUT>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(TIMEOUT);
      }
    }, ms);
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      },
    );
  });
}

function makeEventHandler(
  buf: SentenceBuffer | null,
  on_error: OnError,
): (ev: StreamEvent) => string[] {
  return (ev: StreamEvent) => {
    if (ev.type === "error") raiseIfError(ev, on_error);
    if (ev.type !== "delta") return [];
    if (buf === null) return [ev.text ?? ""];
    return buf.feed(ev.text ?? "");
  };
}

export async function* parseStream(
  chunks: ChunkSource,
  opts: PipelineOptions = {},
): AsyncGenerator<string, void, unknown> {
  const resolved = resolveBuffer(opts.buffer ?? "voice");
  const buf = resolved ? new SentenceBuffer(resolved) : null;
  const core = new ParserCore(
    opts.provider ?? "auto",
    opts.streamFormat ?? "auto",
    opts.on_error ?? "raise",
    opts.textPath,
    opts.toolPath,
  );
  const handle = makeEventHandler(buf, core.on_error);
  const it = sourceIterator(chunks);
  let nextPromise: Promise<IteratorResult<Chunk | Record<string, unknown>>> | null = null;

  for (;;) {
    if (nextPromise === null) nextPromise = it.next();
    const armed =
      resolved !== null &&
      resolved.idleTimeoutMs > 0 &&
      buf !== null &&
      buf.pending.length > 0;
    const res = armed
      ? await raceWithTimeout(nextPromise, resolved.idleTimeoutMs)
      : await nextPromise;
    if (res === TIMEOUT) {
      // idle: flush the held text; the pending next() stays pending
      if (buf) for (const s of buf.forceFlush()) yield s;
      continue;
    }
    nextPromise = null;
    if (res.done) break;
    for (const ev of core.feed(res.value)) for (const s of handle(ev)) yield s;
  }

  for (const ev of core.close()) for (const s of handle(ev)) yield s;
  if (buf) for (const s of buf.close()) yield s;
}

// Web Streams adapter (TransformStream)

export function sentenceTransform(
  opts: PipelineOptions = {},
): TransformStream<Uint8Array, string> {
  const core = new ParserCore(
    opts.provider ?? "auto",
    opts.streamFormat ?? "auto",
    opts.on_error ?? "raise",
    opts.textPath,
    opts.toolPath,
  );
  const resolved = resolveBuffer(opts.buffer ?? "voice");
  const buf = resolved ? new SentenceBuffer(resolved) : null;
  const handle = makeEventHandler(buf, core.on_error);
  const out: string[] = [];

  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      for (const ev of core.feed(chunk)) out.push(...handle(ev));
      while (out.length) controller.enqueue(out.shift()!);
    },
    flush(controller) {
      for (const ev of core.close()) out.push(...handle(ev));
      if (buf) out.push(...buf.close());
      while (out.length) controller.enqueue(out.shift()!);
    },
  });
}

// wrapStream HOF

type RawGen = (
  ...args: unknown[]
) =>
  | AsyncGenerator<Chunk | Record<string, unknown>, void, unknown>
  | Generator<Chunk | Record<string, unknown>, void, unknown>;

export function wrapStream(
  opts: PipelineOptions = {},
): <TArgs extends unknown[], R extends RawGen>(
  gen: R,
) => (...args: TArgs) => AsyncGenerator<string, void, unknown> {
  return (gen) =>
    (...args) => {
      const inner = (gen as RawGen)(...args);
      const source: ChunkSource =
        typeof (inner as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
          ? (inner as AsyncIterable<Chunk | Record<string, unknown>>)
          : (inner as Iterable<Chunk | Record<string, unknown>>);
      return parseStream(source, opts);
    };
}