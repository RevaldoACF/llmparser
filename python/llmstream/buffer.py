from __future__ import annotations

import re
from typing import Iterator, List, Optional

from .types import (
    BufferOptions,
    codepoint_len,
    is_alpha,
    is_alnum,
    is_digit,
    is_space,
)

__all__ = ["SentenceBuffer", "sanitize_for_tts", "withhold_len"]

FENCES = ["```", "~~~"]
CLOSING = set('"’”»)]')


# Sanitizer (SPEC.md §8 — fixed operation order)

_EMOJI_RE = re.compile(
    "["
    "\U0001F000-\U0001FAFF"
    "\u2600-\u27BF"
    "\uFE0F"
    "\u200D"
    "\u20E3"
    "]+"
)
_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]*)\)")
_ANGLE_LINK_RE = re.compile(r"<https?://[^>]+>")
_INLINE_CODE_RE = re.compile(r"`([^`]*)`")
_FENCE_RE = re.compile(r"^```")
_EMPH_RE = re.compile(r"(\*\*|__|~~|\*|_)")
_WS_RE = re.compile(r"\s+")
_LIST_MARKER_RE = re.compile(r"^(?:\s*)(?:[-*+]|\d+\.)\s+")
_HEADING_RE = re.compile(r"^#{1,6}\s+")


def _strip_markdown(s: str) -> str:
    # keep label
    s = _LINK_RE.sub(r"\1", s)
    s = _ANGLE_LINK_RE.sub(" ", s)
    # keep content (empty pair "``" → "")
    s = _INLINE_CODE_RE.sub(r"\1", s)
    # line based
    out_lines: List[str] = []
    for line in s.split("\n"):
        line = _HEADING_RE.sub("", line)
        line = re.sub(r"^\s*>\s?", "", line)
        line = _LIST_MARKER_RE.sub("", line)
        out_lines.append(line)
    s = "\n".join(out_lines)
    # Emphasis markers
    s = _EMPH_RE.sub("", s)
    return s


def sanitize_for_tts(text: str, opts: Optional[BufferOptions] = None) -> str:
    """Apply the normative sanitization pipeline to one sentence."""
    opts = opts or BufferOptions()
    s = text
    if opts.strip_markdown:
        # Fenced blocks
        if "```" in s:
            mode = opts.code_block_mode
            if mode == "drop":
                s = re.sub(r"```[^\n]*\n?[\s\S]*?```", " ", s)
            elif mode == "sanitize":
                s = re.sub(r"```[^\n]*\n?[\s\S]*?```", "(code)", s)
        s = _strip_markdown(s)
    if opts.strip_emoji:
        s = _EMOJI_RE.sub("", s)
    if opts.collapse_whitespace:
        s = _WS_RE.sub(" ", s)
    return s.strip()


# Tag guard helpers

def withhold_len(buf: str, tags: List[str]) -> int:
    """Longest suffix of `buf` that is a proper prefix of any guarded tag."""
    if not buf or not tags:
        return 0
    maxd = max(len(d) for d in tags)
    k = min(len(buf), maxd - 1)
    while k > 0:
        suffix = buf[-k:]
        for d in tags:
            if len(d) > k and d[:k] == suffix:
                return k
        k -= 1
    return 0


_WORD_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_+-"


def _is_fence_opener(buf: str, p: int, d: str) -> bool:
    if p > 0:
        prev = buf[p - 1]
        if prev not in ("\n", " "):
            return False
        if prev == buf[p]:
            return False
    end = p + len(d)
    i = end
    while i < len(buf) and i - end <= 16 and buf[i] in _WORD_ID:
        i += 1
    if i >= len(buf):
        return True
    if buf[i] == "\n":
        return True
    if buf[i] == " " and i + 1 < len(buf):
        return True
    return False


def first_fence_opener(buf: str, d: str) -> int:
    p = 0
    while True:
        p = buf.find(d, p)
        if p < 0:
            return -1
        if _is_fence_opener(buf, p, d):
            return p
        p += 1


def _find_fence_closer(buf: str, d: str, start: int) -> int:
    p = start
    while True:
        p = buf.find(d, p)
        if p < 0:
            return -1
        # lenient closer: not preceded by the fence char (avoids matching the first half of a longer run like "``````"); newline not required
        if p > 0 and buf[p - 1] != d[0]:
            return p
        p += 1


# SentenceBuffer

def _normalize_abbrev(w: str) -> str:
    return w.strip().rstrip(".").lower()


class SentenceBuffer:
    """Holds streamed text until complete sentences are ready.

    Usage:
        buf = SentenceBuffer(BufferOptions())
        for s in buf.feed(token):
            speak(s)
        for s in buf.close():
            speak(s)
    """

    def __init__(self, options: Optional[BufferOptions] = None) -> None:
        self.opts = options or BufferOptions()
        self._buf = ""
        self._last_scan = 0
        self._fence_state = "TEXT"  # TEXT | IN_CODE
        self._fence_delim = ""

    # state

    @property
    def pending(self) -> str:
        """Currently held unflushed text"""
        return self._buf

    def _region(self) -> int:
        if self._fence_state == "IN_CODE":
            return 0
        return len(self._buf) - withhold_len(self._buf, self.opts.all_guard_tags)

    # boundary scanning

    def _is_abbrev_before(self, i: int) -> bool:
        buf = self._buf
        j = i - 1
        while j >= 0 and (is_alpha(buf[j]) or buf[j] == "."):
            j -= 1
        word = buf[j + 1: i]
        return _normalize_abbrev(word) in self.opts.abbreviations

    def _find_boundary(self, upto: int) -> int:
        """Return end index (exclusive) of the next sentence boundary, or -1."""
        buf = self._buf
        n = len(buf)
        # spaces in the enders/soft strings are separators, not boundary chars
        enders = {c for c in self.opts.sentence_enders if not c.isspace()}
        soft = (
            {c for c in self.opts.soft_boundary if not c.isspace()}
            if self.opts.strategy == "clause"
            else set()
        )
        i = self._last_scan
        while i < upto:
            ch = buf[i]
            if ch in enders:
                end = i
                while end + 1 < n and buf[end + 1] == ch:
                    end += 1
                end = min(end, upto - 1)
                # abbreviation
                if ch == "." and self._is_abbrev_before(i):
                    i = end + 1
                    continue
                # token-continuation dot
                if (
                    ch == "."
                    and i > 0
                    and i + 1 < n
                    and not is_space(buf[i - 1])
                    and (is_alnum(buf[i + 1]) or buf[i + 1] == ".")
                ):
                    i = end + 1
                    continue
                # valid
                if end + 1 >= n or is_space(buf[end + 1]) or buf[end + 1] in CLOSING:
                    while end + 1 < n and buf[end + 1] in CLOSING:
                        end += 1
                    return min(end, upto - 1) + 1
            elif ch in soft:
                # candidate already meets min_chunk_size
                if i + 1 >= n or is_space(buf[i + 1]):
                    candidate = sanitize_for_tts(buf[0: i + 1], self.opts)
                    if codepoint_len(candidate) >= self.opts.min_chunk_size:
                        return i + 1
            i += 1
        return -1

    def _last_soft_boundary(self, upto: int) -> int:
        buf = self._buf
        n = len(buf)
        soft = {c for c in self.opts.soft_boundary if not c.isspace()}
        for i in range(upto - 1, -1, -1):
            if buf[i] in soft:
                if i + 1 >= n or is_space(buf[i + 1]):
                    return i + 1
        return -1

    # flush primitives

    def _flush(self, upto: int) -> Optional[str]:
        raw = self._buf[:upto]
        self._buf = self._buf[upto:]
        self._last_scan = 0
        s = sanitize_for_tts(raw, self.opts)
        return s if s != "" else None

    def _emit_code_block(self, upto: int) -> Optional[str]:
        raw = self._buf[:upto]
        self._buf = self._buf[upto:]
        self._fence_state = "TEXT"
        self._fence_delim = ""
        mode = self.opts.code_block_mode
        if mode == "passthrough":
            return raw if raw.strip() else None
        if mode == "sanitize":
            return "(code)"
        return None  # drop

    # guard step

    def _guard_step(self, force: bool = False) -> str:
        if self._fence_state == "IN_CODE":
            p = _find_fence_closer(self._buf, self._fence_delim, len(self._fence_delim))
            if p < 0:
                if force or len(self._buf) >= self.opts.max_buffer_size:
                    out = self._emit_code_block(len(self._buf))
                    self._emit_out = out
                    return "code_emitted"
                return "holding"
            out = self._emit_code_block(p + len(self._fence_delim))
            self._emit_out = out
            return "code_emitted"

        for d in FENCES:
            p = first_fence_opener(self._buf, d)
            if p < 0:
                continue
            if p > 0:
                pre = self._buf[:p]
                s = sanitize_for_tts(pre, self.opts)
                self._pre_out = s if s != "" else None
                self._buf = self._buf[p:]
                self._last_scan = 0
            self._fence_state = "IN_CODE"
            self._fence_delim = d
            return "fence_started"
        return "text"

    _emit_out: Optional[str] = None
    _pre_out: Optional[str] = None

    # Public API

    def feed(self, token: str) -> Iterator[str]:
        if token == "":
            return
        self._buf += token
        out: List[str] = []
        while True:
            g = self._guard_step()
            if g == "holding":
                break
            if g in ("fence_started", "code_emitted", "structural_flush"):
                if g == "fence_started" and self._pre_out is not None:
                    out.append(self._pre_out)
                    self._pre_out = None
                if g == "code_emitted" and self._emit_out is not None:
                    out.append(self._emit_out)
                    self._emit_out = None
                continue

            region = self._region()
            w = withhold_len(self._buf, self.opts.all_guard_tags)
            if region == 0 and (len(self._buf) - w) < self.opts.max_buffer_size:
                break

            if self.opts.strategy == "fixed":
                if len(self._buf) - w >= self.opts.min_chunk_size:
                    s = self._flush(self.opts.min_chunk_size)
                    if s is not None:
                        out.append(s)
                break
            elif self.opts.strategy.startswith("regex:"):
                pat = self.opts.strategy[len("regex:"):]
                m = re.compile(pat).search(self._buf, 0, region)
                if m:
                    s = self._flush(m.end())
                    if s is not None:
                        out.append(s)
                break
            else:
                b = self._find_boundary(region)
                if b != -1:
                    candidate = self._buf[:b]
                    if codepoint_len(sanitize_for_tts(candidate, self.opts)) >= self.opts.min_chunk_size:
                        s = self._flush(b)
                        if s is not None:
                            out.append(s)
                        self._last_scan = 0
                    else:
                        self._last_scan = b
                else:
                    if (len(self._buf) - w) >= self.opts.max_buffer_size:
                        cut = self._last_soft_boundary(region)
                        if cut != -1 and codepoint_len(
                            sanitize_for_tts(self._buf[:cut], self.opts)
                        ) >= self.opts.min_chunk_size:
                            s = self._flush(cut)
                        else:
                            # hard cut at the ceiling
                            cut = min(region, self.opts.max_buffer_size)
                            s = self._flush(cut) if cut > 0 else None
                        if s is not None:
                            out.append(s)
                    break
        return iter(out)

    def force_flush(self) -> Iterator[str]:
        """Idle-timeout flush"""
        region = self._region()
        s = self._flush(region)
        return iter([s] if s is not None else [])

    def close(self) -> Iterator[str]:
        out: List[str] = []
        if self._fence_state == "IN_CODE":
            g = self._guard_step(force=True)
            if g == "code_emitted" and self._emit_out is not None:
                out.append(self._emit_out)
                self._emit_out = None
        s = self._flush(len(self._buf))
        self._last_scan = 0
        if s is not None:
            out.append(s)
        return iter(out)
