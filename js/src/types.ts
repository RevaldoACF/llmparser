export type EventType =
  | "delta"
  | "reasoning_delta"
  | "tool_call_delta"
  | "tool_call_complete"
  | "usage"
  | "metadata"
  | "error"
  | "done";

/**
 * Normalized event produced by provider adapters (discriminated by `type`)
 * Field presence depends on `type`
 */
export interface StreamEvent {
  type: EventType;
  // delta / reasoning_delta
  text?: string;
  // tool_call_delta / tool_call_complete
  index?: number;
  id?: string;
  name?: string;
  arguments_delta?: string;
  arguments?: Record<string, unknown>;
  raw_arguments?: string;
  // usage
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  // metadata
  provider?: string;
  model?: string;
  finish_reason?: string;
  raw?: Record<string, unknown>;
  // error
  code?: string;
  message?: string;
  provider_error?: Record<string, unknown>;
}

export type BufferStrategy = "sentence" | "clause" | "fixed" | `regex:${string}`;
export type CodeBlockMode = "passthrough" | "drop" | "sanitize";
export type OnError = "raise" | "skip";

/** Sentence-buffer configuration */
export interface BufferOptions {
  /** Minimum flushed sentence length in codepoints. @default 40 */
  minChunkSize?: number;
  /** Force-flush ceiling in codepoints. @default 400 */
  maxBufferSize?: number;
  /** async pipelines only (ignored in sync/Transform usage). @default 0 */
  idleTimeoutMs?: number;
  strategy?: BufferStrategy;
  /** Note: spaces inside are separators, not boundary chars. @default ". ! ? … 。 ！" */
  sentenceEnders?: string;
  /** Soft boundary chars. @default ", ; : —" */
  softBoundary?: string;
  stripMarkdown?: boolean;
  stripEmoji?: boolean;
  collapseWhitespace?: boolean;
  /** Fence delimiters guarded by the tag guard. @default ["```", "~~~", "`"] */
  guardTags?: string[];
  /** Extra user tags (e.g. TTS control tags). @default [] */
  guardTagsExtra?: string[];
  codeBlockMode?: CodeBlockMode;
  /** Extra abbreviations (lowercased; trailing dots optional). @default [] */
  additionalAbbrevs?: string[];
  on_error?: OnError;
}

/** Preset shorthands */
export type BufferPreset = "voice" | "ui" | "off";
export type BufferLike = BufferOptions | BufferPreset | false | undefined | null;

/** A fully assembled, validated tool call */
export interface ToolCall {
  index: number;
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
  raw_arguments?: string;
}

// Unicode helpers

const ABBREV_BASE = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "no", "fig", "vs",
  "etc", "inc", "ltd", "co", "corp", "approx", "dept", "est", "min",
  "max", "vol", "pg", "pp", "e.g", "i.e", "cf", "al", "gen", "rep",
  "sen", "assn",
]);

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v", "\u00a0",
  "\u1680", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005",
  "\u2006", "\u2007", "\u2008", "\u2009", "\u200a", "\u2028", "\u2029",
  "\u202f", "\u205f", "\u3000"]);
const ALPHA_RE = /\p{L}/u;

/** Codepoint length (NOT UTF-16 `str.length`) */
export function codepointLen(s: string): number {
  let n = 0;
  for (const _c of s) n++;
  return n;
}

/** Split a string into codepoints (mirrors Python str indexing) */
export function cps(s: string): string[] {
  return Array.from(s);
}

export function isSpace(c: string): boolean {
  return WHITESPACE.has(c);
}

export function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

export function isAlpha(c: string): boolean {
  return ALPHA_RE.test(c);
}

export function isAlnum(c: string): boolean {
  return isAlpha(c) || isDigit(c);
}

export function normalizeAbbrev(w: string): string {
  return w.trim().replace(/\.+$/, "").toLowerCase();
}

export function abbrevSet(extra: string[]): Set<string> {
  const s = new Set(ABBREV_BASE);
  for (const a of extra) s.add(normalizeAbbrev(a));
  return s;
}

// Options resolution

export interface ResolvedBufferOptions {
  minChunkSize: number;
  maxBufferSize: number;
  idleTimeoutMs: number;
  strategy: BufferStrategy;
  sentenceEnders: string;
  softBoundary: string;
  stripMarkdown: boolean;
  stripEmoji: boolean;
  collapseWhitespace: boolean;
  guardTags: string[];
  guardTagsExtra: string[];
  codeBlockMode: CodeBlockMode;
  additionalAbbrevs: string[];
  on_error: OnError;
  enderSet: Set<string>;
  softSet: Set<string>;
  allGuardTags: string[];
  abbreviations: Set<string>;
}

/** Expand a preset / options object / false into resolved options (or null) */
export function resolveBuffer(buffer?: BufferLike): ResolvedBufferOptions | null {
  if (buffer === false || buffer === null || buffer === undefined) return null;
  if (typeof buffer === "string") {
    if (buffer === "off") return null;
    if (buffer === "voice") return PRESET_VOICE;
    if (buffer === "ui") return PRESET_UI;
    throw new Error(`unknown buffer preset: ${buffer}`);
  }
  return resolveBufferOptions(buffer);
}

/**
 * Accept snake_case keys (the spec/vector naming) as aliases for the
 * camelCase option names, so shared test vectors and cross-language
 * configs work unchanged. `idle_timeout` (seconds) converts to ms
 */
const SNAKE_ALIASES: Record<string, string> = {
  min_chunk_size: "minChunkSize",
  max_buffer_size: "maxBufferSize",
  idle_timeout: "__idle_seconds",
  sentence_enders: "sentenceEnders",
  soft_boundary: "softBoundary",
  strip_markdown: "stripMarkdown",
  strip_emoji: "stripEmoji",
  collapse_whitespace: "collapseWhitespace",
  guard_tags: "guardTags",
  guard_tags_extra: "guardTagsExtra",
  code_block_mode: "codeBlockMode",
  additional_abbrevs: "additionalAbbrevs",
};

function normalizeOptions(p?: BufferOptions): BufferOptions {
  if (!p || typeof p !== "object") return p ?? {};
  const out: Record<string, unknown> = { ...p };
  let idleSeconds: number | undefined;
  for (const [snake, camel] of Object.entries(SNAKE_ALIASES)) {
    if (snake in out && (out as any)[camel] === undefined) {
      const v = (out as any)[snake];
      if (camel === "__idle_seconds") idleSeconds = v;
      else (out as any)[camel] = v;
      delete out[snake];
    }
  }
  if (idleSeconds !== undefined && (out as any).idleTimeoutMs === undefined)
    (out as any).idleTimeoutMs = Math.round(idleSeconds * 1000);
  return out as BufferOptions;
}

export function resolveBufferOptions(p?: BufferOptions): ResolvedBufferOptions {
  p = normalizeOptions(p);
  const o: ResolvedBufferOptions = {
    minChunkSize: p?.minChunkSize ?? 40,
    maxBufferSize: p?.maxBufferSize ?? 400,
    idleTimeoutMs: p?.idleTimeoutMs ?? 0,
    strategy: p?.strategy ?? "sentence",
    sentenceEnders: p?.sentenceEnders ?? ". ! ? … 。 ！",
    softBoundary: p?.softBoundary ?? ", ; : —",
    stripMarkdown: p?.stripMarkdown ?? true,
    stripEmoji: p?.stripEmoji ?? true,
    collapseWhitespace: p?.collapseWhitespace ?? true,
    guardTags: p?.guardTags ?? ["```", "~~~", "`"],
    guardTagsExtra: p?.guardTagsExtra ?? [],
    codeBlockMode: p?.codeBlockMode ?? "passthrough",
    additionalAbbrevs: p?.additionalAbbrevs ?? [],
    on_error: p?.on_error ?? "raise",
    enderSet: new Set(),
    softSet: new Set(),
    allGuardTags: [],
    abbreviations: new Set(),
  };
  // spaces in enders/soft strings are separators, not boundary chars
  for (const c of o.sentenceEnders) if (!isSpace(c)) o.enderSet.add(c);
  for (const c of o.softBoundary) if (!isSpace(c)) o.softSet.add(c);
  o.allGuardTags = [...o.guardTags, ...o.guardTagsExtra];
  o.abbreviations = abbrevSet(o.additionalAbbrevs);
  return o;
}

// Presets (defined after resolveBufferOptions; lazy access via getters so module-init order is safe).
const _VOICE = resolveBufferOptions(
  { minChunkSize: 40, maxBufferSize: 400, idleTimeoutMs: 500,
    strategy: "sentence", sentenceEnders: ". ! ? … 。 ！", softBoundary: ", ; : —",
    stripMarkdown: true, stripEmoji: true, collapseWhitespace: true,
    guardTags: ["```", "~~~", "`"], guardTagsExtra: [], codeBlockMode: "passthrough",
    additionalAbbrevs: [], on_error: "raise" }
);
const _UI = resolveBufferOptions(
  { minChunkSize: 20, strategy: "clause", stripMarkdown: false,
    stripEmoji: false, idleTimeoutMs: 0 }
);

/** TTS-optimized defaults (idle 500ms) */
export const PRESET_VOICE: ResolvedBufferOptions = _VOICE;
/** Low-latency caption defaults */
export const PRESET_UI: ResolvedBufferOptions = _UI;