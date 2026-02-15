import type { MiraEmotion } from "@/hooks/useOrbAvatar";

const VALID_EMOTIONS: MiraEmotion[] = ["idle", "neutral", "proud", "teasing"];

/** Parse [emotion:X] prefix tag from Claude's response. */
export function parseEmotionTag(text: string): {
  emotion: MiraEmotion;
  cleanText: string;
} {
  const match = text.match(/^\[emotion:(\w+)\]\s*/);
  if (match) {
    const tag = match[1] as MiraEmotion;
    return {
      emotion: VALID_EMOTIONS.includes(tag) ? tag : "neutral",
      cleanText: text.slice(match[0].length),
    };
  }
  return { emotion: "neutral", cleanText: text };
}
