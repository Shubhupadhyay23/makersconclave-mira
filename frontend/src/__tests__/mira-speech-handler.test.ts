import { describe, it, expect, vi } from "vitest";
import { SentenceBuffer } from "@/lib/sentence-buffer";
import { findScriptedResponse, detectEmotion } from "@/lib/scripted-responses";

/**
 * Simulate the mira_speech handler logic from mirror/page.tsx.
 *
 * This reproduces the exact branching that processes streamed chunks
 * and the end-of-message flush signal, including the scripted response
 * matching and TTS continuation for remaining text.
 */
function createHandler(onSentence: (s: string) => void) {
  let accumulator = "";
  let pendingTTSAfterScripted: string | null = null;
  const sentenceBuffer = new SentenceBuffer(onSentence);

  const handler = (data: { text?: string; is_chunk?: boolean }) => {
    if (data.is_chunk !== false) {
      // Chunk branch — skip empty chunks
      if (!data.text) return;
      accumulator += data.text;
    } else {
      // New complete message — discard stale pending TTS
      pendingTTSAfterScripted = null;
      // End-of-message branch — must always run
      if (data.text) {
        accumulator += data.text;
      }
      const fullText = accumulator;
      accumulator = "";
      if (!fullText) return;

      const scripted = findScriptedResponse(fullText);

      if (scripted) {
        const phraseIdx = fullText.toLowerCase().indexOf(scripted.phrase);
        const afterPhrase = phraseIdx >= 0
          ? fullText.slice(phraseIdx + scripted.phrase.length).trim()
          : "";
        if (afterPhrase) {
          pendingTTSAfterScripted = afterPhrase;
        }
        // avatar.playScripted(scripted.video) — simulated by caller
      } else {
        sentenceBuffer.feed(fullText);
        sentenceBuffer.flush();
      }
    }
  };

  /** Simulate the scripted video ending (isSpeaking → false) */
  const drainPendingTTS = () => {
    if (pendingTTSAfterScripted) {
      const text = pendingTTSAfterScripted;
      pendingTTSAfterScripted = null;
      sentenceBuffer.feed(text);
      sentenceBuffer.flush();
    }
  };

  return { handler, drainPendingTTS };
}

describe("mira_speech handler", () => {
  it("flushes accumulated chunks when end-of-message arrives with empty text", () => {
    const onSentence = vi.fn();
    const { handler } = createHandler(onSentence);

    // Simulate streaming: 3 chunks then end-of-message with text: ""
    handler({ text: "Hello ", is_chunk: true });
    handler({ text: "world, ", is_chunk: true });
    handler({ text: "how are you?", is_chunk: true });
    handler({ text: "", is_chunk: false });

    expect(onSentence).toHaveBeenCalled();
    const allText = onSentence.mock.calls.map((c) => c[0]).join(" ");
    expect(allText).toContain("Hello world, how are you?");
  });

  it("flushes when end-of-message carries final text", () => {
    const onSentence = vi.fn();
    const { handler } = createHandler(onSentence);

    handler({ text: "First part. ", is_chunk: true });
    handler({ text: "Last part", is_chunk: false });

    expect(onSentence).toHaveBeenCalled();
    const allText = onSentence.mock.calls.map((c) => c[0]).join(" ");
    expect(allText).toContain("First part.");
    expect(allText).toContain("Last part");
  });

  it("skips empty chunks without breaking accumulation", () => {
    const onSentence = vi.fn();
    const { handler } = createHandler(onSentence);

    handler({ text: "Start", is_chunk: true });
    handler({ text: "", is_chunk: true }); // empty chunk — ignored
    handler({ text: " end", is_chunk: true });
    handler({ text: "", is_chunk: false });

    const allText = onSentence.mock.calls.map((c) => c[0]).join(" ");
    expect(allText).toContain("Start end");
  });

  it("does nothing when end-of-message arrives with no accumulated text", () => {
    const onSentence = vi.fn();
    const { handler } = createHandler(onSentence);

    handler({ text: "", is_chunk: false });

    expect(onSentence).not.toHaveBeenCalled();
  });

  it("handles multiple complete message cycles", () => {
    const onSentence = vi.fn();
    const { handler } = createHandler(onSentence);

    // First message
    handler({ text: "First message.", is_chunk: true });
    handler({ text: "", is_chunk: false });
    expect(onSentence).toHaveBeenCalledTimes(1);

    onSentence.mockClear();

    // Second message
    handler({ text: "Second message.", is_chunk: true });
    handler({ text: "", is_chunk: false });
    expect(onSentence).toHaveBeenCalledTimes(1);
  });

  it("scripted match stashes remainder and drains via TTS after video ends", () => {
    const onSentence = vi.fn();
    const { handler, drainPendingTTS } = createHandler(onSentence);

    // Response starts with a scripted phrase followed by unique text
    handler({
      text: "okay here's the thing, you should try a bomber jacket with those jeans.",
      is_chunk: false,
    });

    // Scripted video playing — onSentence should NOT have been called yet
    expect(onSentence).not.toHaveBeenCalled();

    // Simulate video ending (isSpeaking → false triggers drain)
    drainPendingTTS();

    // Now the remainder should have been fed through the sentence buffer
    expect(onSentence).toHaveBeenCalled();
    const allText = onSentence.mock.calls.map((c) => c[0]).join(" ");
    expect(allText).toContain("you should try a bomber jacket");
  });

  it("scripted match with no remainder does not trigger TTS", () => {
    const onSentence = vi.fn();
    const { handler, drainPendingTTS } = createHandler(onSentence);

    // Response IS the scripted phrase (nothing after it)
    handler({ text: "okay here's the thing", is_chunk: false });

    drainPendingTTS();

    // No TTS should fire — the scripted video is the entire response
    expect(onSentence).not.toHaveBeenCalled();
  });

  it("new message clears stale pending TTS from previous scripted match", () => {
    const onSentence = vi.fn();
    const { handler, drainPendingTTS } = createHandler(onSentence);

    // First message: scripted match with remainder
    handler({
      text: "okay here's the thing, try a bomber jacket.",
      is_chunk: false,
    });
    expect(onSentence).not.toHaveBeenCalled();

    // Second message arrives before video ends — clears stale pending TTS
    handler({ text: "Actually never mind. Wear something else.", is_chunk: false });

    // drainPendingTTS should have nothing — it was cleared by the new message
    drainPendingTTS();

    // Only the second (non-scripted) message should have gone through
    const allText = onSentence.mock.calls.map((c) => c[0]).join(" ");
    expect(allText).toContain("Actually never mind");
    expect(allText).not.toContain("bomber jacket");
  });
});
