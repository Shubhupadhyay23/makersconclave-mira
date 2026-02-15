/**
 * ElevenLabs TTS client — calls the backend proxy at /api/tts/speak.
 *
 * Falls back to browser SpeechSynthesis if the proxy is unavailable.
 */

export class ElevenLabsTTS {
  private apiUrl: string;
  private audio: HTMLAudioElement | null = null;
  private speaking = false;
  /** Tracks the blob URL so stop() can revoke it */
  private pendingBlobUrl: string | null = null;
  /** Resolves the pending speak() promise so stop() doesn't leave it dangling */
  private pendingResolve: (() => void) | null = null;
  /** Monotonic counter — incremented by stop() to invalidate in-flight fetches */
  private generation = 0;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
  }

  async speak(
    text: string,
    onStart?: () => void,
    onEnd?: () => void,
  ): Promise<void> {
    const gen = ++this.generation;

    try {
      console.log("[TTS] Sending to ElevenLabs:", text.slice(0, 100));
      this.speaking = true;
      onStart?.();

      const resp = await fetch(`${this.apiUrl}/api/tts/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      // Cancelled while fetching — bail silently
      if (this.generation !== gen) {
        this.speaking = false;
        return;
      }

      if (!resp.ok) {
        throw new Error(`TTS proxy error: ${resp.status}`);
      }

      const blob = await resp.blob();

      // Cancelled while reading blob — bail silently
      if (this.generation !== gen) {
        this.speaking = false;
        return;
      }

      const url = URL.createObjectURL(blob);
      this.pendingBlobUrl = url;

      await new Promise<void>((resolve) => {
        this.pendingResolve = resolve;

        // Guard: onended, onerror, and play().catch() can each fire —
        // only the first one should run cleanup + callbacks.
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          this.pendingResolve = null;
          if (this.pendingBlobUrl === url) {
            URL.revokeObjectURL(url);
            this.pendingBlobUrl = null;
          }
          this.speaking = false;
          onEnd?.();
          resolve();
        };

        this.audio = new Audio(url);

        this.audio.onended = () => {
          console.log("[TTS] Playback finished:", text.slice(0, 60));
          done();
        };

        this.audio.onerror = () => {
          console.warn("[TTS] Audio error:", text.slice(0, 60));
          done();
        };

        this.audio.play().catch(() => {
          done();
        });
      });
    } catch (err) {
      console.warn("[TTS] ElevenLabs proxy failed, falling back to browser TTS:", err);
      this.speaking = false;

      // Browser TTS fallback
      await this.browserFallback(text, onStart, onEnd);
    }
  }

  stop(): void {
    // Invalidate any in-flight fetches
    this.generation++;

    if (this.audio) {
      // Remove listeners BEFORE pausing to prevent stale callbacks
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio = null;
    }
    if (this.pendingBlobUrl) {
      URL.revokeObjectURL(this.pendingBlobUrl);
      this.pendingBlobUrl = null;
    }
    this.speaking = false;
    // Resolve dangling promise so the caller's chain doesn't hang forever
    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
    }
    window.speechSynthesis?.cancel();
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  private browserFallback(
    text: string,
    onStart?: () => void,
    onEnd?: () => void,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!window.speechSynthesis) {
        onEnd?.();
        resolve();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.1;

      utterance.onstart = () => {
        this.speaking = true;
        onStart?.();
      };

      utterance.onend = () => {
        this.speaking = false;
        onEnd?.();
        resolve();
      };

      utterance.onerror = () => {
        this.speaking = false;
        onEnd?.();
        resolve();
      };

      window.speechSynthesis.speak(utterance);
    });
  }
}
