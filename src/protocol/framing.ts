// Line framing and argument parsing for the legacy Spring lobby protocol.
//
// Wire format: each message is one '\n'-terminated line. The command word comes
// first (space-separated). Most arguments are space-separated "words"; some
// commands carry trailing free-text fields ("sentences") that may contain spaces
// and are separated from the words — and from each other — by TAB ('\t').
//
// We parse defensively: split the part before the first TAB into space-separated
// words, and the part after the first TAB into tab-separated sentences. Callers
// pick whichever they need (e.g. BATTLEOPENED's title lives in the sentences).

export interface ParsedMessage {
  /** Upper-cased command word, e.g. "BATTLEOPENED". */
  cmd: string;
  /** Space-separated tokens after the command, up to the first TAB. */
  words: string[];
  /** Tab-separated free-text fields after the first TAB (may be empty). */
  sentences: string[];
  /** The original line without its trailing newline. */
  raw: string;
}

export function parseMessage(line: string): ParsedMessage {
  const raw = line.replace(/\r$/, "");
  const tabIdx = raw.indexOf("\t");
  const head = tabIdx === -1 ? raw : raw.slice(0, tabIdx);
  const tail = tabIdx === -1 ? "" : raw.slice(tabIdx + 1);

  const headTokens = head.length ? head.split(" ") : [];
  const cmd = (headTokens.shift() ?? "").toUpperCase();
  const sentences = tail.length ? tail.split("\t") : [];

  return { cmd, words: headTokens, sentences, raw };
}

/**
 * Stateful splitter that turns an arriving stream of string chunks into complete
 * protocol lines (without the trailing '\n'). Holds a partial trailing line until
 * its newline arrives.
 */
export class LineBuffer {
  private buf = "";

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      lines.push(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
    return lines;
  }
}
