import { useCallback, useEffect, useRef, useState } from "react";
import { SentenceBuffer } from "../buffer";
import { parseEvents, type PipelineOptions } from "../pipeline";
import { resolveBuffer, type BufferLike, type ToolCall } from "../types";

export type StreamStatus = "idle" | "streaming" | "done" | "error";

export interface UseLLMStreamOptions extends Omit<PipelineOptions, "buffer"> {
  /** Buffer config. @default "voice" */
  buffer?: BufferLike;
  /** Called for each complete sentence as it's produced */
  onSentence?: (sentence: string, all: string[]) => void;
  /** Called for each validated tool call (complete JSON only) */
  onToolCall?: (tc: ToolCall) => void;
}

export interface StartOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Override provider for this request */
  provider?: PipelineOptions["provider"];
  /** Override buffer for this request */
  buffer?: BufferLike;
  signal?: AbortSignal;
}

export interface UseLLMStreamResult {
  sentences: string[];
  partial: string;
  toolCalls: ToolCall[];
  status: StreamStatus;
  error: Error | null;
  /** Start streaming from a URL. Resolves when the stream ends */
  start: (url: string, opts?: StartOptions) => Promise<void>;
  /** Abort the current stream */
  abort: () => void;
  /** Reset all state. */
  reset: () => void;
}

const PARTIAL_THROTTLE_MS = 33; // ~30fps

export function useLLMStream(options: UseLLMStreamOptions = {}): UseLLMStreamResult {
  const [sentences, setSentences] = useState<string[]>([]);
  const [partial, setPartial] = useState("");
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const partialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPartialRef = useRef<string>("");
  const lastPartialPushRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      if (partialTimerRef.current) clearTimeout(partialTimerRef.current);
    };
  }, []);

  const flushPartial = useCallback(() => {
    if (partialTimerRef.current) {
      clearTimeout(partialTimerRef.current);
      partialTimerRef.current = null;
    }
    if (!mountedRef.current) return;
    setPartial(pendingPartialRef.current);
  }, []);

  const schedulePartial = useCallback(
    (text: string) => {
      pendingPartialRef.current = text;
      const now = Date.now();
      const elapsed = now - lastPartialPushRef.current;
      if (elapsed >= PARTIAL_THROTTLE_MS) {
        lastPartialPushRef.current = now;
        flushPartial();
        return;
      }
      if (!partialTimerRef.current) {
        partialTimerRef.current = setTimeout(
          () => {
            lastPartialPushRef.current = Date.now();
            flushPartial();
          },
          PARTIAL_THROTTLE_MS - elapsed,
        );
      }
    },
    [flushPartial],
  );

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (partialTimerRef.current) clearTimeout(partialTimerRef.current);
    partialTimerRef.current = null;
    pendingPartialRef.current = "";
    if (!mountedRef.current) return;
    setSentences([]);
    setPartial("");
    setToolCalls([]);
    setStatus("idle");
    setError(null);
  }, []);

  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (!mountedRef.current) return;
    setStatus((s) => (s === "streaming" ? "done" : s));
  }, []);

  const start = useCallback(
    async (url: string, startOpts: StartOptions = {}) => {
      // previous stream in flight? abort it
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mountedRef.current) {
        setSentences([]);
        setPartial("");
        setToolCalls([]);
        setError(null);
        setStatus("streaming");
      }

      const o = optionsRef.current;
      const bufferLike = startOpts.buffer ?? o.buffer ?? "voice";
      let res: Response;
      try {
        res = await fetch(url, {
          method: startOpts.method ?? "GET",
          headers: startOpts.headers,
          body: startOpts.body,
          signal: startOpts.signal ?? controller.signal,
        });
      } catch (e) {
        if (!mountedRef.current) return;
        if ((e as Error).name !== "AbortError") {
          setStatus("error");
          setError(e as Error);
        }
        return;
      }

      if (!res.body) {
        if (mountedRef.current) {
          setStatus("error");
          setError(new Error("response has no body (streaming unsupported)"));
        }
        return;
      }

      const resolved = resolveBuffer(bufferLike);
      const buf = resolved ? new SentenceBuffer(resolved) : null;
      const acc: string[] = [];
      const accTools: ToolCall[] = [];

      try {
        for await (const ev of parseEvents(res.body, {
          ...o,
          provider: startOpts.provider ?? o.provider ?? "auto",
        })) {
          if (!mountedRef.current) return;
          if (ev.type === "delta") {
            const out = buf ? buf.feed(ev.text ?? "") : [ev.text ?? ""];
            for (const s of out) {
              acc.push(s);
              setSentences([...acc]);
              o.onSentence?.(s, [...acc]);
            }
            if (buf) schedulePartial(buf.pending);
          } else if (ev.type === "tool_call_complete") {
            const tc: ToolCall = {
              index: ev.index ?? 0,
              id: ev.id,
              name: ev.name ?? "",
              arguments: (ev.arguments as Record<string, unknown>) ?? {},
              raw_arguments: ev.raw_arguments,
            };
            accTools.push(tc);
            setToolCalls([...accTools]);
            o.onToolCall?.(tc);
          } else if (ev.type === "done") {
            break;
          }
        }
        if (!mountedRef.current) return;
        if (buf) {
          for (const s of buf.close()) {
            acc.push(s);
            o.onSentence?.(s, [...acc]);
          }
          setSentences([...acc]);
        }
        flushPartial();
        setStatus("done");
      } catch (e) {
        if (!mountedRef.current) return;
        const err = e as Error;
        if (err.name === "AbortError") setStatus("done");
        else {
          setStatus("error");
          setError(err);
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [flushPartial, schedulePartial],
  );

  return { sentences, partial, toolCalls, status, error, start, abort, reset };
}