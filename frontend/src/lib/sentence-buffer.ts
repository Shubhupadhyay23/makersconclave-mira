/**
 * Accumulates streaming text chunks and flushes complete sentences.
 *
 * Sentence boundaries are `.` `!` `?` followed by a space or end-of-input.
 * Handles edge cases: decimal numbers ($29.99), ellipsis (...), empty chunks.
 */
export class SentenceBuffer {
  private buffer = "";
  private onSentence: (sentence: string) => void;

  constructor(onSentence: (sentence: string) => void) {
    this.onSentence = onSentence;
  }

  feed(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;
    this.drainSentences();
  }

  flush(): void {
    const text = this.buffer.trim();
    if (text) {
      console.log("[SentenceBuffer] Flushing remainder:", text);
      this.onSentence(text);
    }
    this.buffer = "";
  }

  private drainSentences(): void {
    // Match sentence-ending punctuation followed by a space.
    // Negative lookbehind avoids splitting on:
    //   - decimal numbers: digit.digit (e.g. $29.99)
    //   - ellipsis: two or more dots (e.g. "hmm...")
    const sentenceEnd = /(?<!\d)(?<!\.)([.!?])\s/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;

    while ((match = sentenceEnd.exec(this.buffer)) !== null) {
      // Include the punctuation mark, not the trailing space
      const sentence = this.buffer.slice(lastIndex, match.index + match[1].length).trim();
      if (sentence) {
        console.log("[SentenceBuffer] Sentence:", sentence);
        this.onSentence(sentence);
      }
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex > 0) {
      this.buffer = this.buffer.slice(lastIndex);
    }
  }
}
