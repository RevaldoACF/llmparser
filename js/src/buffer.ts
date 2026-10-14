import {
  type BufferOptions,
  type ResolvedBufferOptions,
  codepointLen,
  cps,
  isAlpha,
  isAlnum,
  isSpace,
  normalizeAbbrev,
  resolveBufferOptions,
} from "./types";

const FENCES = ["```", "~~~"];
const CLOSING = new Set(['"', "\u2019", "\u201D", "\u00BB", "]", ")"]);
const WORD_ID = /^[A-Za-z0-9_+\-]$/;

// Sanitizer (SPEC.md §8 — fixed operation order)

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D\u20E3]+/gu;
const LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
const ANGLE_LINK_RE = /<https?:\/\/[^>]+>/g;
const INLINE_CODE_RE = /`([^`]*)`/g;
const EMPH_RE = /(\*\*|__|~~|\*|_)/g;
const WS_RE = /\s+/gu;
const LIST_MARKER_RE = /^(?:\s*)(?:[-*+]|\d+\.)\s+/;
const HEADING_RE = /^#{1,6}\s+/;
const FENCE_BLOCK_RE = /```[^\n]*\n?[\s\S]*?```/g;

function stripMarkdown(s: string): string {
  // Keep label
  s = s.replace(LINK_RE, "$1");
  s = s.replace(ANGLE_LINK_RE, " ");
  // Inline code: keep content (empty pair "``" -> "")
  s = s.replace(INLINE_CODE_RE, "$1");
  // Headings / blockquotes / list markers (line-based)
  s = s
    .split("\n")
    .map((line) =>
      line
        .replace(HEADING_RE, "")
        .replace(/^\s*>\s?/, "")
        .replace(LIST_MARKER_RE, ""),
    )
    .join("\n");
  // Emphasis markers only (content kept)
  s = s.replace(EMPH_RE, "");
  return s;
}

/** Apply the normative sanitization pipeline to one sentence */
export function sanitizeForTts(
  text: string,
  opts?: BufferOptions | ResolvedBufferOptions,
): string {
  const o: ResolvedBufferOptions =
    opts && "enderSet" in opts ? opts : resolveBufferOptions(opts as BufferOptions);
  let s = text;
  if (o.stripMarkdown) {
    if (s.includes("```")) {
      if (o.codeBlockMode === "drop") s = s.replace(FENCE_BLOCK_RE, " ");
      else if (o.codeBlockMode === "sanitize") s = s.replace(FENCE_BLOCK_RE, "(code)");
    }
    s = stripMarkdown(s);
  }
  if (o.stripEmoji) s = s.replace(EMOJI_RE, "");
  if (o.collapseWhitespace) s = s.replace(WS_RE, " ");
  return s.trim();
}

// Tag guard helpers

/** Longest suffix of `buf` that is a proper prefix of any guarded tag*/
export function withholdLen(buf: string, tags: string[]): number {
  if (!buf || tags.length === 0) return 0;
  let maxd = 0;
  for (const d of tags) if (d.length > maxd) maxd = d.length;
  let k = Math.min(codepointLen(buf), maxd - 1);
  const cs = cps(buf);
  const n = cs.length;
  while (k > 0) {
    const suffix = cs.slice(n - k).join("");
    for (const d of tags) {
      if (d.length > k && d.slice(0, k) === suffix) return k;
    }
    k -= 1;
  }
  return 0;
}

function isFenceOpener(buf: string, p: number, d: string): boolean {
  if (p > 0) {
    const prev = buf[p - 1];
    if (prev !== "\n" && prev !== " ") return false;
    if (prev === buf[p]) return false;
  }
  const end = p + d.length;
  let i = end;
  while (i < buf.length && i - end <= 16 && WORD_ID.test(buf[i])) i += 1;
  if (i >= buf.length) return true;
  if (buf[i] === "\n") return true;
  if (buf[i] === " " && i + 1 < buf.length) return true;
  return false;
}

function firstFenceOpener(buf: string, d: string): number {
  let p = buf.indexOf(d);
  while (p >= 0) {
    if (isFenceOpener(buf, p, d)) return p;
    p = buf.indexOf(d, p + 1);
  }
  return -1;
}

function findFenceCloser(buf: string, d: string, start: number): number {
  let p = buf.indexOf(d, start);
  while (p >= 0) {
    if (p > 0 && buf[p - 1] !== d[0]) return p;
    p = buf.indexOf(d, p + 1);
  }
  return -1;
}

// SentenceBuffer

export type GuardStepResult =
  | "text"
  | "holding"
  | "fence_started"
  | "code_emitted";

export class SentenceBuffer {
  private opts: ResolvedBufferOptions;
  private buf = "";
  private lastScan = 0;
  private fenceState: "TEXT" | "IN_CODE" = "TEXT";
  private fenceDelim = "";
  private preOut: string | null = null;
  private emitOut: string | null = null;

  constructor(options?: BufferOptions | ResolvedBufferOptions | null) {
    this.opts =
      options && "enderSet" in options
        ? options
        : resolveBufferOptions((options ?? {}) as BufferOptions);
  }

  /** Currently held unflushed text */
  get pending(): string {
    return this.buf;
  }

  // -- state

  private region(): number {
    if (this.fenceState === "IN_CODE") return 0;
    return codepointLen(this.buf) - withholdLen(this.buf, this.opts.allGuardTags);
  }

  // -- boundary scanning

  private isAbbrevBefore(i: number): boolean {
    const cs = cps(this.buf);
    let j = i - 1;
    while (j >= 0 && (isAlpha(cs[j]) || cs[j] === ".")) j -= 1;
    const word = cs.slice(j + 1, i).join("");
    return this.opts.abbreviations.has(normalizeAbbrev(word));
  }

  /** Return end index (exclusive, codepoints) of the next boundary, or -1 */
  private findBoundary(upto: number): number {
    const cs = cps(this.buf);
    const n = cs.length;
    const enders = this.opts.enderSet;
    const soft = this.opts.strategy === "clause" ? this.opts.softSet : new Set<string>();
    let i = this.lastScan;
    while (i < upto) {
      const ch = cs[i];
      if (enders.has(ch)) {
        let end = i;
        while (end + 1 < n && cs[end + 1] === ch) end += 1;
        end = Math.min(end, upto - 1);
        // abbreviation
        if (ch === "." && this.isAbbrevBefore(i)) {
          i = end + 1;
          continue;
        }
        // token-continuation dot
        if (
          ch === "." &&
          i > 0 &&
          i + 1 < n &&
          !isSpace(cs[i - 1]) &&
          (isAlnum(cs[i + 1]) || cs[i + 1] === ".")
        ) {
          i = end + 1;
          continue;
        }
        // validity
        if (end + 1 >= n || isSpace(cs[end + 1]) || CLOSING.has(cs[end + 1])) {
          while (end + 1 < n && CLOSING.has(cs[end + 1])) end += 1;
          return Math.min(end, upto - 1) + 1;
        }
      } else if (soft.has(ch)) {
        if (i + 1 >= n || isSpace(cs[i + 1])) {
          const candidate = sanitizeForTts(cs.slice(0, i + 1).join(""), this.opts);
          if (codepointLen(candidate) >= this.opts.minChunkSize) return i + 1;
        }
      }
      i += 1;
    }
    return -1;
  }

  private lastSoftBoundary(upto: number): number {
    const cs = cps(this.buf);
    const n = cs.length;
    for (let i = upto - 1; i >= 0; i--) {
      if (this.opts.softSet.has(cs[i])) {
        if (i + 1 >= n || isSpace(cs[i + 1])) return i + 1;
      }
    }
    return -1;
  }

  // -- flush primitives

  private flush(upto: number): string | null {
    const cs = cps(this.buf);
    const raw = cs.slice(0, upto).join("");
    this.buf = cs.slice(upto).join("");
    this.lastScan = 0;
    const s = sanitizeForTts(raw, this.opts);
    return s !== "" ? s : null;
  }

  private emitCodeBlock(upto: number): string | null {
    const cs = cps(this.buf);
    const raw = cs.slice(0, upto).join("");
    this.buf = cs.slice(upto).join("");
    this.fenceState = "TEXT";
    this.fenceDelim = "";
    if (this.opts.codeBlockMode === "passthrough")
      return raw.trim() ? raw : null;
    if (this.opts.codeBlockMode === "sanitize") return "(code)";
    return null; // drop
  }

  // -- guard step

  private guardStep(force = false): GuardStepResult {
    if (this.fenceState === "IN_CODE") {
      const p = findFenceCloser(this.buf, this.fenceDelim, this.fenceDelim.length);
      if (p < 0) {
        if (force || codepointLen(this.buf) >= this.opts.maxBufferSize) {
          this.emitOut = this.emitCodeBlock(codepointLen(this.buf));
          return "code_emitted";
        }
        return "holding";
      }
      this.emitOut = this.emitCodeBlock(p + this.fenceDelim.length);
      return "code_emitted";
    }

    for (const d of FENCES) {
      const p = firstFenceOpener(this.buf, d);
      if (p < 0) continue;
      if (p > 0) {
        const cs = cps(this.buf);
        const pre = cs.slice(0, p).join("");
        const s = sanitizeForTts(pre, this.opts);
        this.preOut = s !== "" ? s : null;
        this.buf = cs.slice(p).join("");
        this.lastScan = 0;
      }
      this.fenceState = "IN_CODE";
      this.fenceDelim = d;
      return "fence_started";
    }
    return "text";
  }

  // -- public API

  feed(token: string): string[] {
    if (token === "") return [];
    this.buf += token;
    const out: string[] = [];
    for (;;) {
      const g = this.guardStep();
      if (g === "holding") break;
      if (g === "fence_started" || g === "code_emitted") {
        if (g === "fence_started" && this.preOut !== null) {
          out.push(this.preOut);
          this.preOut = null;
        }
        if (g === "code_emitted" && this.emitOut !== null) {
          out.push(this.emitOut);
          this.emitOut = null;
        }
        continue;
      }

      const region = this.region();
      const w = withholdLen(this.buf, this.opts.allGuardTags);
      if (region === 0 && codepointLen(this.buf) - w < this.opts.maxBufferSize) break;

      if (this.opts.strategy === "fixed") {
        if (codepointLen(this.buf) - w >= this.opts.minChunkSize) {
          const s = this.flush(this.opts.minChunkSize);
          if (s !== null) out.push(s);
        }
        break;
      } else if (this.opts.strategy.startsWith("regex:")) {
        const pat = this.opts.strategy.slice("regex:".length);
        const m = new RegExp(pat).exec(cps(this.buf).slice(0, region).join(""));
        if (m) {
          const s = this.flush(m.index + m[0].length);
          if (s !== null) out.push(s);
        }
        break;
      } else {
        const b = this.findBoundary(region);
        if (b !== -1) {
          const cs = cps(this.buf);
          const candidate = cs.slice(0, b).join("");
          if (
            codepointLen(sanitizeForTts(candidate, this.opts)) >=
            this.opts.minChunkSize
          ) {
            const s = this.flush(b);
            if (s !== null) out.push(s);
            this.lastScan = 0;
          } else {
            this.lastScan = b;
          }
        } else {
          if (codepointLen(this.buf) - w >= this.opts.maxBufferSize) {
            const cut = this.lastSoftBoundary(region);
            let s: string | null = null;
            if (
              cut !== -1 &&
              codepointLen(
                sanitizeForTts(cps(this.buf).slice(0, cut).join(""), this.opts),
              ) >= this.opts.minChunkSize
            ) {
              s = this.flush(cut);
            } else {
              // hard cut at the ceiling (word-boundary aware)
              const c = Math.min(region, this.opts.maxBufferSize);
              s = c > 0 ? this.flush(c) : null;
            }
            if (s !== null) out.push(s);
          }
          break;
        }
      }
    }
    return out;
  }

  /** Idle-timeout flush */
  forceFlush(): string[] {
    const region = this.region();
    const s = this.flush(region);
    return s !== null ? [s] : [];
  }

  /** flush remainder + close any open fence. */
  close(): string[] {
    const out: string[] = [];
    if (this.fenceState === "IN_CODE") {
      const g = this.guardStep(true);
      if (g === "code_emitted" && this.emitOut !== null) {
        out.push(this.emitOut);
        this.emitOut = null;
      }
    }
    const s = this.flush(codepointLen(this.buf));
    this.lastScan = 0;
    if (s !== null) out.push(s);
    return out;
  }
}