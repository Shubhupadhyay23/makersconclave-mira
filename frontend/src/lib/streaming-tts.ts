/**
 * Streaming TTS client using ElevenLabs REST streaming endpoint.
 *
 * Uses fetch + ReadableStream + MediaSource API for low-latency audio playback.
 * Extracts real-time volume via AudioContext + AnalyserNode for Orb visualization.
 */

export class StreamingTTS {
  private apiUrl: string;
  private generation = 0;
  private speaking = false;
  private audio: HTMLAudioElement | null = null;
  private mediaSource: MediaSource | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private frequencyData: Uint8Array<ArrayBuffer> | null = null;
  private pendingResolve: (() => void) | null = null;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
  }

  /**
   * Stream TTS audio for the given text.
   * Returns a promise that resolves when playback finishes.
   */
  async speak(
    text: string,
    onStart?: () => void,
    onEnd?: () => void,
  ): Promise<void> {
    const gen = ++this.generation;

    try {
      this.speaking = true;

      const resp = await fetch(`${this.apiUrl}/api/tts/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (this.generation !== gen) {
        this.speaking = false;
        return;
      }

      if (!resp.ok || !resp.body) {
        throw new Error(`TTS stream failed: ${resp.status}`);
      }

      await this.playStream(resp.body, gen, onStart, onEnd);
    } catch (err) {
      console.error("[StreamingTTS] Error:", err);
      this.speaking = false;
      onEnd?.();
    }
  }

  private async playStream(
    body: ReadableStream<Uint8Array>,
    gen: number,
    onStart?: () => void,
    onEnd?: () => void,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pendingResolve = resolve;

      const mediaSource = new MediaSource();
      this.mediaSource = mediaSource;

      const audio = new Audio();
      this.audio = audio;
      audio.src = URL.createObjectURL(mediaSource);

      // Connect to AudioContext for volume analysis
      this.connectAnalyser(audio);

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.pendingResolve = null;
        this.speaking = false;
        if (audio.src) {
          URL.revokeObjectURL(audio.src);
        }
        onEnd?.();
        resolve();
      };

      audio.onerror = done;
      audio.onended = done;

      mediaSource.addEventListener("sourceopen", () => {
        if (this.generation !== gen) {
          done();
          return;
        }

        let sourceBuffer: SourceBuffer;
        try {
          sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
        } catch {
          console.error("[StreamingTTS] Failed to add source buffer");
          done();
          return;
        }

        const reader = body.getReader();
        let started = false;

        const pump = async () => {
          try {
            const { done: readerDone, value } = await reader.read();

            if (this.generation !== gen) {
              reader.cancel();
              if (mediaSource.readyState === "open") {
                mediaSource.endOfStream();
              }
              done();
              return;
            }

            if (readerDone) {
              if (mediaSource.readyState === "open" && !sourceBuffer.updating) {
                mediaSource.endOfStream();
              } else if (mediaSource.readyState === "open") {
                sourceBuffer.addEventListener(
                  "updateend",
                  () => {
                    if (mediaSource.readyState === "open") {
                      mediaSource.endOfStream();
                    }
                  },
                  { once: true },
                );
              }
              console.log("[StreamingTTS] Stream complete");
              return;
            }

            if (sourceBuffer.updating) {
              // Wait for the current update to finish before appending
              await new Promise<void>((res) => {
                sourceBuffer.addEventListener("updateend", () => res(), {
                  once: true,
                });
              });
            }

            sourceBuffer.appendBuffer(value as unknown as BufferSource);

            if (!started) {
              started = true;
              console.log("[StreamingTTS] Playback starting");
              onStart?.();
              audio.play().catch(() => {
                console.warn("[StreamingTTS] Autoplay blocked");
              });
            }

            sourceBuffer.addEventListener("updateend", () => pump(), {
              once: true,
            });
          } catch (err) {
            console.error("[StreamingTTS] Pump error:", err);
            done();
          }
        };

        pump();
      });
    });
  }

  private connectAnalyser(audio: HTMLAudioElement): void {
    try {
      if (!this.audioContext) {
        this.audioContext = new AudioContext();
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.7;
        this.analyser.connect(this.audioContext.destination);
        this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
      }

      // Resume context if suspended (browser autoplay policy)
      if (this.audioContext.state === "suspended") {
        this.audioContext.resume();
      }

      // createMediaElementSource can only be called once per element,
      // so we disconnect the old source and create a new one
      if (this.sourceNode) {
        this.sourceNode.disconnect();
        this.sourceNode = null;
      }

      const source = this.audioContext.createMediaElementSource(audio);
      source.connect(this.analyser!);
      this.sourceNode = source;
    } catch (err) {
      console.warn("[StreamingTTS] AudioContext setup failed:", err);
    }
  }

  /**
   * Get current output volume (0-1) for feeding to the Orb component.
   * Uses the same power-curve normalization as ElevenLabs SDK.
   */
  getOutputVolume(): number {
    if (!this.analyser || !this.frequencyData || !this.speaking) return 0;

    this.analyser.getByteFrequencyData(this.frequencyData);

    let sum = 0;
    for (let i = 0; i < this.frequencyData.length; i++) {
      sum += this.frequencyData[i];
    }
    const raw = sum / (this.frequencyData.length * 255);

    // Power-curve normalization (same as ElevenLabs SDK voice-chat blocks)
    return Math.min(1.0, Math.pow(raw, 0.5) * 2.5);
  }

  /** Stop current playback and cancel any in-flight stream. */
  stop(): void {
    this.generation++;
    this.speaking = false;

    if (this.audio) {
      this.audio.pause();
      if (this.audio.src) {
        URL.revokeObjectURL(this.audio.src);
      }
      this.audio = null;
    }

    if (this.mediaSource?.readyState === "open") {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // Already ended
      }
    }
    this.mediaSource = null;

    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
    }
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  /** Clean up AudioContext on teardown. */
  destroy(): void {
    this.stop();
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.analyser = null;
    this.frequencyData = null;
  }
}
