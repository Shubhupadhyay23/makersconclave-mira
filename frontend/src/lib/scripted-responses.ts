/**
 * Scripted response matching — maps Mira's phrases to pre-recorded
 * video clips with baked-in audio for perfect lip sync.
 *
 * Ported from jenny/src/scripted-responses.js.
 */

import type { AvatarState } from "./memoji-avatar";

export interface ScriptedResponse {
  phrase: string;
  video: string;
  emotion: AvatarState;
  keywords: string[];
}

interface ScriptedEntry {
  video: string;
  emotion: AvatarState;
  keywords: string[];
}

const SCRIPTED_RESPONSES: Record<string, ScriptedEntry> = {
  // Judgmental
  "ew that's gross": {
    video: "/avatar/scripted/judgmental_gross.mp4",
    emotion: "concerned",
    keywords: ["gross", "ew", "disgusting", "ugly"],
  },
  "oh no honey what is that": {
    video: "/avatar/scripted/judgmental_honey.mp4",
    emotion: "concerned",
    keywords: ["honey", "what is that", "oh no"],
  },
  "that's... a choice": {
    video: "/avatar/scripted/judgmental_choice.mp4",
    emotion: "concerned",
    keywords: ["choice", "interesting choice", "bold"],
  },

  // Confused
  "why would you wear that": {
    video: "/avatar/scripted/confused_why.mp4",
    emotion: "thinking",
    keywords: ["why", "wear that", "why would"],
  },
  "wait what is happening here": {
    video: "/avatar/scripted/confused_what.mp4",
    emotion: "thinking",
    keywords: ["what is happening", "what", "wait"],
  },
  "i'm so confused right now": {
    video: "/avatar/scripted/confused_lost.mp4",
    emotion: "thinking",
    keywords: ["confused", "lost", "don't understand"],
  },

  // Positive
  "okay i love that": {
    video: "/avatar/scripted/positive_love.mp4",
    emotion: "excited",
    keywords: ["love", "love that", "love it"],
  },
  "yes this is it": {
    video: "/avatar/scripted/positive_yes.mp4",
    emotion: "excited",
    keywords: ["yes", "this is it", "perfect"],
  },
  "you look amazing": {
    video: "/avatar/scripted/positive_amazing.mp4",
    emotion: "happy",
    keywords: ["amazing", "look amazing", "stunning", "gorgeous"],
  },

  // Neutral
  "hmm let me see": {
    video: "/avatar/scripted/neutral_see.mp4",
    emotion: "thinking",
    keywords: ["hmm", "let me see", "thinking"],
  },
  "okay here's the thing": {
    video: "/avatar/scripted/neutral_thing.mp4",
    emotion: "thinking",
    keywords: ["here's the thing", "the thing is", "okay so"],
  },

  // Supportive
  "you know what it works": {
    video: "/avatar/scripted/supportive_works.mp4",
    emotion: "happy",
    keywords: ["it works", "works", "actually works"],
  },
  "not bad at all": {
    video: "/avatar/scripted/supportive_notbad.mp4",
    emotion: "happy",
    keywords: ["not bad", "pretty good", "decent"],
  },
};

/**
 * Find the best scripted response match for the given text.
 *
 * Pass 1: exact phrase `includes()` (case-insensitive).
 * Pass 2: keyword scoring — longer keywords score higher. Threshold = 8.
 *
 * Only searches within the first `maxChars` characters (default 80) so that
 * scripted opener phrases deep inside a multi-paragraph response don't match.
 * Pass `maxChars=0` to search the full text.
 */
export function findScriptedResponse(text: string, maxChars = 80): ScriptedResponse | null {
  const searchText = maxChars > 0 ? text.slice(0, maxChars).toLowerCase() : text.toLowerCase();

  // Pass 1 — exact phrase match
  for (const [phrase, data] of Object.entries(SCRIPTED_RESPONSES)) {
    if (searchText.includes(phrase)) {
      return { phrase, ...data };
    }
  }

  // Pass 2 — keyword scoring
  let bestMatch: ScriptedResponse | null = null;
  let bestScore = 0;

  for (const [phrase, data] of Object.entries(SCRIPTED_RESPONSES)) {
    let score = 0;
    for (const keyword of data.keywords) {
      if (searchText.includes(keyword)) {
        score += keyword.length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { phrase, ...data };
    }
  }

  return bestScore >= 8 ? bestMatch : null;
}

/**
 * Regex-based fallback emotion detection when no scripted match.
 * Used to pick a looping avatar state for the TTS path.
 */
export function detectEmotion(text: string): AvatarState {
  const lower = text.toLowerCase();

  if (/ew|gross|ugly|terrible|awful|yuck|no no|honey/.test(lower)) {
    return "concerned";
  }
  if (/confused|what|why|huh|\?{2,}|don't understand/.test(lower)) {
    return "thinking";
  }
  if (/love|amazing|perfect|yes!|gorgeous|stunning|beautiful|great/.test(lower)) {
    return "excited";
  }
  if (/good|nice|works|not bad|decent|okay|fine/.test(lower)) {
    return "happy";
  }
  if (/hmm|let me|thinking|consider/.test(lower)) {
    return "thinking";
  }

  return "talking";
}
