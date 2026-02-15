import { describe, it, expect, vi } from "vitest";
import { parseEmotionTag } from "@/lib/emotion-parser";

/**
 * Simulate the new mira_speech handler logic from mirror/page.tsx.
 *
 * The new flow is simpler: accumulate chunks → parse emotion tag → speak.
 * No more scripted matching, sentence buffering, or pending TTS drain.
 */
function createHandler(onSpeak: (text: string, emotion: string) => void) {
  let accumulator = "";

  const handler = (data: { text?: string; is_chunk?: boolean }) => {
    if (data.is_chunk !== false) {
      if (!data.text) return;
      accumulator += data.text;
    } else {
      if (data.text) {
        accumulator += data.text;
      }
      const fullText = accumulator;
      accumulator = "";
      if (!fullText) return;

      const { emotion, cleanText } = parseEmotionTag(fullText);
      onSpeak(cleanText, emotion);
    }
  };

  return { handler };
}

describe("mira_speech handler (orb flow)", () => {
  it("flushes accumulated chunks when end-of-message arrives", () => {
    const onSpeak = vi.fn();
    const { handler } = createHandler(onSpeak);

    handler({ text: "Hello ", is_chunk: true });
    handler({ text: "world, ", is_chunk: true });
    handler({ text: "how are you?", is_chunk: true });
    handler({ text: "", is_chunk: false });

    expect(onSpeak).toHaveBeenCalledTimes(1);
    expect(onSpeak).toHaveBeenCalledWith("Hello world, how are you?", "neutral");
  });

  it("parses emotion tag and strips it from text", () => {
    const onSpeak = vi.fn();
    const { handler } = createHandler(onSpeak);

    handler({
      text: "[emotion:teasing] Oh honey, those cargo shorts?",
      is_chunk: false,
    });

    expect(onSpeak).toHaveBeenCalledWith("Oh honey, those cargo shorts?", "teasing");
  });

  it("parses emotion tag from accumulated chunks", () => {
    const onSpeak = vi.fn();
    const { handler } = createHandler(onSpeak);

    handler({ text: "[emotion:proud] Now ", is_chunk: true });
    handler({ text: "THAT is a look.", is_chunk: true });
    handler({ text: "", is_chunk: false });

    expect(onSpeak).toHaveBeenCalledWith("Now THAT is a look.", "proud");
  });

  it("defaults to neutral when no emotion tag present", () => {
    const onSpeak = vi.fn();
    const { handler } = createHandler(onSpeak);

    handler({ text: "Just plain text.", is_chunk: false });

    expect(onSpeak).toHaveBeenCalledWith("Just plain text.", "neutral");
  });

  it("skips empty chunks without breaking accumulation", () => {
    const onSpeak = vi.fn();
    const { handler } = createHandler(onSpeak);

    handler({ text: "Start", is_chunk: true });
    handler({ text: "", is_chunk: true }); // empty chunk — ignored
    handler({ text: " end", is_chunk: true });
    handler({ text: "", is_chunk: false });

    expect(onSpeak).toHaveBeenCalledWith("Start end", "neutral");
  });

  it("does nothing when end-of-message arrives with no accumulated text", () => {
    const onSpeak = vi.fn();
    const { handler } = createHandler(onSpeak);

    handler({ text: "", is_chunk: false });

    expect(onSpeak).not.toHaveBeenCalled();
  });

  it("handles multiple complete message cycles", () => {
    const onSpeak = vi.fn();
    const { handler } = createHandler(onSpeak);

    // First message
    handler({ text: "[emotion:proud] First.", is_chunk: false });
    expect(onSpeak).toHaveBeenCalledWith("First.", "proud");

    onSpeak.mockClear();

    // Second message
    handler({ text: "[emotion:teasing] Second.", is_chunk: false });
    expect(onSpeak).toHaveBeenCalledWith("Second.", "teasing");
  });

  it("flushes when end-of-message carries final text", () => {
    const onSpeak = vi.fn();
    const { handler } = createHandler(onSpeak);

    handler({ text: "[emotion:neutral] First part. ", is_chunk: true });
    handler({ text: "Last part", is_chunk: false });

    expect(onSpeak).toHaveBeenCalledTimes(1);
    const [cleanText, emotion] = onSpeak.mock.calls[0];
    expect(cleanText).toContain("First part.");
    expect(cleanText).toContain("Last part");
    expect(emotion).toBe("neutral");
  });

  it("defaults unknown emotion tags to neutral", () => {
    const onSpeak = vi.fn();
    const { handler } = createHandler(onSpeak);

    handler({ text: "[emotion:unknown] Some text.", is_chunk: false });

    expect(onSpeak).toHaveBeenCalledWith("Some text.", "neutral");
  });
});
