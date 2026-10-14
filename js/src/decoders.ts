export type Chunk = Uint8Array | string;

export interface WireRecord {
  data: string;
  event?: string;
}

export class SSEDecoder {
  private _buf = "";
  private _data: string | null = null;
  private _event: string | null = null;
  private _utf8 = new TextDecoder("utf-8", { fatal: false });
  /** True once at least one record has been produced (auto-format detection) */
  hasSeenData = false;

  /** returns decoded records (possibly zero) */
  feed(chunk: Chunk): WireRecord[] {
    this._buf += typeof chunk === "string" ? chunk : this._utf8.decode(chunk, { stream: true });
    const out: WireRecord[] = [];
    for (;;) {
      const nl = this._buf.indexOf("\n");
      if (nl < 0) break;
      let line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const rec = this._processLine(line);
      if (rec) out.push(rec);
    }
    return out;
  }

  private _processLine(line: string): WireRecord | null {
    if (line === "") {
      if (this._data !== null) {
        const rec: WireRecord = { data: this._data, event: this._event ?? undefined };
        this._data = null;
        this._event = null;
        this.hasSeenData = true;
        return rec;
      }
      return null;
    }
    if (line[0] === ":") return null; // comment / keep-alive
    if (line.startsWith("data:")) {
      let v = line.slice(5);
      if (v.startsWith(" ")) v = v.slice(1);
      this._data = this._data === null ? v : this._data + "\n" + v;
      return null;
    }
    if (line.startsWith("event:")) {
      let v = line.slice(6);
      if (v.startsWith(" ")) v = v.slice(1);
      this._event = v;
      return null;
    }
    // "id:" / "retry:" / unknown fields: ignored
    return null;
  }

  /** Flush a trailing data field that never saw its blank line */
  close(): WireRecord | null {
    this._buf += this._utf8.decode(new Uint8Array(0)); // finalize
    if (this._data === null) return null;
    const rec: WireRecord = { data: this._data, event: this._event ?? undefined };
    this._data = null;
    this._event = null;
    this.hasSeenData = true;
    return rec;
  }
}

export class JsonLinesDecoder {
  private _buf = "";
  private _utf8 = new TextDecoder("utf-8", { fatal: false });

  feed(chunk: Chunk): string[] {
    this._buf += typeof chunk === "string" ? chunk : this._utf8.decode(chunk, { stream: true });
    const out: string[] = [];
    for (;;) {
      const nl = this._buf.indexOf("\n");
      if (nl < 0) break;
      let line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) out.push(line);
    }
    return out;
  }

  close(): string | null {
    this._buf += this._utf8.decode(new Uint8Array(0));
    const line = this._buf;
    this._buf = "";
    return line.trim() ? line : null;
  }
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}