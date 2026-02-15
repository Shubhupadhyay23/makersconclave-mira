import { describe, it, expect, vi } from "vitest";
import { SentenceBuffer } from "@/lib/sentence-buffer";

describe("SentenceBuffer", () => {
  it("flushes on period followed by space", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("Hello world. ");
    expect(onSentence).toHaveBeenCalledWith("Hello world.");
  });

  it("flushes on question mark", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("How are you? ");
    expect(onSentence).toHaveBeenCalledWith("How are you?");
  });

  it("flushes on exclamation mark", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("Wow! ");
    expect(onSentence).toHaveBeenCalledWith("Wow!");
  });

  it("accumulates chunks until sentence boundary", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("Hello ");
    buffer.feed("world");
    expect(onSentence).not.toHaveBeenCalled();

    buffer.feed(". ");
    expect(onSentence).toHaveBeenCalledWith("Hello world.");
  });

  it("handles multiple sentences in one chunk", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("First. Second. ");
    expect(onSentence).toHaveBeenCalledTimes(2);
    expect(onSentence).toHaveBeenNthCalledWith(1, "First.");
    expect(onSentence).toHaveBeenNthCalledWith(2, "Second.");
  });

  it("flush() sends remaining buffer content", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("Trailing text without punctuation");
    expect(onSentence).not.toHaveBeenCalled();

    buffer.flush();
    expect(onSentence).toHaveBeenCalledWith(
      "Trailing text without punctuation",
    );
  });

  it("flush() is a no-op when buffer is empty", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.flush();
    expect(onSentence).not.toHaveBeenCalled();
  });

  it("does not split on periods inside numbers", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("Price is $29.99 for this item. ");
    expect(onSentence).toHaveBeenCalledTimes(1);
    expect(onSentence).toHaveBeenCalledWith(
      "Price is $29.99 for this item.",
    );
  });

  it("handles empty string feed gracefully", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("");
    buffer.feed("");
    expect(onSentence).not.toHaveBeenCalled();
  });

  it("handles ellipsis without splitting", () => {
    const onSentence = vi.fn();
    const buffer = new SentenceBuffer(onSentence);

    buffer.feed("Hmm... let me think. ");
    // Should not split at the ellipsis, only at the final period
    expect(onSentence).toHaveBeenCalledTimes(1);
  });
});
