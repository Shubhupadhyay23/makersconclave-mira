import { describe, it, expect } from "vitest";
import { parseEmotionTag } from "@/lib/emotion-parser";

describe("parseEmotionTag", () => {
  it("parses [emotion:teasing] correctly", () => {
    const result = parseEmotionTag("[emotion:teasing] Oh honey, those cargo shorts?");
    expect(result.emotion).toBe("teasing");
    expect(result.cleanText).toBe("Oh honey, those cargo shorts?");
  });

  it("parses [emotion:proud] correctly", () => {
    const result = parseEmotionTag("[emotion:proud] Now THAT is a look.");
    expect(result.emotion).toBe("proud");
    expect(result.cleanText).toBe("Now THAT is a look.");
  });

  it("parses [emotion:neutral] correctly", () => {
    const result = parseEmotionTag("[emotion:neutral] I found some options.");
    expect(result.emotion).toBe("neutral");
    expect(result.cleanText).toBe("I found some options.");
  });

  it("parses [emotion:idle] correctly", () => {
    const result = parseEmotionTag("[emotion:idle] Just hanging out.");
    expect(result.emotion).toBe("idle");
    expect(result.cleanText).toBe("Just hanging out.");
  });

  it("defaults unknown emotions to neutral", () => {
    const result = parseEmotionTag("[emotion:angry] This is bad!");
    expect(result.emotion).toBe("neutral");
    expect(result.cleanText).toBe("This is bad!");
  });

  it("defaults to neutral when no tag present", () => {
    const result = parseEmotionTag("Just plain text without a tag.");
    expect(result.emotion).toBe("neutral");
    expect(result.cleanText).toBe("Just plain text without a tag.");
  });

  it("handles tag with extra whitespace after bracket", () => {
    const result = parseEmotionTag("[emotion:teasing]   Extra spaces here.");
    expect(result.emotion).toBe("teasing");
    expect(result.cleanText).toBe("Extra spaces here.");
  });

  it("does not match tag in the middle of text", () => {
    const result = parseEmotionTag("Hello [emotion:proud] world");
    expect(result.emotion).toBe("neutral");
    expect(result.cleanText).toBe("Hello [emotion:proud] world");
  });

  it("handles empty text after tag", () => {
    const result = parseEmotionTag("[emotion:proud] ");
    expect(result.emotion).toBe("proud");
    expect(result.cleanText).toBe("");
  });

  it("handles empty string input", () => {
    const result = parseEmotionTag("");
    expect(result.emotion).toBe("neutral");
    expect(result.cleanText).toBe("");
  });
});
