from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Iterator, List, Optional, Union

__all__ = ["WireRecord", "SSEDecoder", "JsonLinesDecoder"]

Chunk = Union[bytes, str]


@dataclass
class WireRecord:
    """One decoded SSE record"""

    data: str
    event: Optional[str] = None


class _IncrementalUTF8:
    def __init__(self) -> None:
        import codecs

        self._dec = codecs.getincrementaldecoder("utf-8")("replace")

    def decode(self, data: bytes, final: bool = False) -> str:
        return self._dec.decode(data, final)


class SSEDecoder:

    def __init__(self) -> None:
        self._buf = ""
        self._data: Optional[str] = None
        self._event: Optional[str] = None
        self._utf8 = _IncrementalUTF8()
        self.has_seen_data = False  # for auto format-detection

    def feed(self, chunk: Chunk) -> List[WireRecord]:
        self._buf += self._utf8.decode(chunk) if isinstance(chunk, bytes) else chunk
        out: List[WireRecord] = []
        while True:
            nl = self._buf.find("\n")
            if nl < 0:
                break
            line = self._buf[:nl]
            self._buf = self._buf[nl + 1:]
            if line.endswith("\r"):
                line = line[:-1]
            rec = self._process_line(line)
            if rec is not None:
                out.append(rec)
        return out

    def _process_line(self, line: str) -> Optional[WireRecord]:
        if line == "":
            if self._data is not None:
                rec = WireRecord(data=self._data, event=self._event)
                self._data = None
                self._event = None
                self.has_seen_data = True
                return rec
            return None
        if line[0] == ":":
            return None  # comment / keep-alive
        if line.startswith("data:"):
            v = line[5:]
            if v.startswith(" "):
                v = v[1:]
            self._data = (self._data + "\n" + v) if self._data is not None else v
            return None
        if line.startswith("event:"):
            v = line[6:]
            if v.startswith(" "):
                v = v[1:]
            self._event = v
            return None
        # "id:" / "retry:" / unknown fields(captured nowhere, ignored)
        return None

    def close(self) -> Optional[WireRecord]:
        """Flush a trailing data field that never saw its blank line."""
        if self._data is None:
            return None
        self._utf8.decode(b"", final=True)
        rec = WireRecord(data=self._data, event=self._event)
        self._data = None
        self._event = None
        self.has_seen_data = True
        return rec


class JsonLinesDecoder:

    def __init__(self) -> None:
        self._buf = ""
        self._utf8 = _IncrementalUTF8()

    def feed(self, chunk: Chunk) -> Iterator[str]:
        self._buf += self._utf8.decode(chunk) if isinstance(chunk, bytes) else chunk
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            if line.endswith("\r"):
                line = line[:-1]
            if line.strip():
                yield line

    def close(self) -> Optional[str]:
        line = self._buf
        self._buf = ""
        self._utf8.decode(b"", final=True)
        return line if line.strip() else None


def parse_json(text: str):
    return json.loads(text)
