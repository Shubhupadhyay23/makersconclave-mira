import { describe, it, expect } from "vitest";
import { findScriptedResponse } from "@/lib/scripted-responses";

describe("findScriptedResponse", () => {
  describe("exact phrase matching (pass 1)", () => {
    it("matches a scripted phrase at the start of text", () => {
      const result = findScriptedResponse("okay here's the thing, you should try a bomber jacket");
      expect(result).not.toBeNull();
      expect(result!.phrase).toBe("okay here's the thing");
    });

    it("does not match a phrase that appears past the maxChars boundary", () => {
      // Pad with 90 chars of filler so the phrase lands well past the 80-char window
      const filler = "x".repeat(90);
      const result = findScriptedResponse(`${filler} okay here's the thing`);
      expect(result).toBeNull();
    });

    it("matches when maxChars=0 searches full text", () => {
      const filler = "x".repeat(200);
      const result = findScriptedResponse(`${filler} okay here's the thing`, 0);
      expect(result).not.toBeNull();
      expect(result!.phrase).toBe("okay here's the thing");
    });
  });

  describe("keyword scoring (pass 2)", () => {
    it("does not match a single short keyword below threshold 8", () => {
      // "what" alone scores 4 — below the threshold of 8
      const result = findScriptedResponse("what is going on today");
      expect(result).toBeNull();
    });

    it("matches when multiple keywords exceed threshold 8", () => {
      // "hmm" (3) + "let me see" (10) = 13 — above threshold
      const result = findScriptedResponse("hmm let me see what we have");
      expect(result).not.toBeNull();
      expect(result!.phrase).toBe("hmm let me see");
    });

    it("does not match keywords past the maxChars boundary", () => {
      const filler = "x".repeat(90);
      const result = findScriptedResponse(`${filler} hmm let me see what we have`);
      expect(result).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for empty text", () => {
      expect(findScriptedResponse("")).toBeNull();
    });

    it("returns null for text with no matching phrases or keywords", () => {
      expect(findScriptedResponse("the weather is nice today")).toBeNull();
    });

    it("includes video and emotion in matched result", () => {
      const result = findScriptedResponse("you look amazing today");
      expect(result).not.toBeNull();
      expect(result!.video).toMatch(/\.mp4$/);
      expect(result!.emotion).toBeTruthy();
    });
  });
});
