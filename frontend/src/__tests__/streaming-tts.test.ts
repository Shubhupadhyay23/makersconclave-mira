import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StreamingTTS } from "@/lib/streaming-tts";

// Mock browser APIs not available in jsdom
function createMockSourceBuffer() {
  let updating = false;
  const listeners: Record<string, Array<() => void>> = {};
  return {
    get updating() {
      return updating;
    },
    appendBuffer(data: Uint8Array) {
      updating = true;
      // Simulate async buffer append
      setTimeout(() => {
        updating = false;
        (listeners["updateend"] || []).forEach((fn) => fn());
        listeners["updateend"] = [];
      }, 0);
    },
    addEventListener(event: string, fn: () => void, opts?: { once?: boolean }) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    },
    removeEventListener() {},
  };
}

function createMockMediaSource() {
  let readyState = "closed" as "closed" | "open" | "ended";
  const sourceBuffer = createMockSourceBuffer();
  const listeners: Record<string, Array<() => void>> = {};

  return {
    get readyState() {
      return readyState;
    },
    addSourceBuffer() {
      return sourceBuffer;
    },
    endOfStream() {
      readyState = "ended";
    },
    addEventListener(event: string, fn: () => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
      if (event === "sourceopen") {
        readyState = "open";
        setTimeout(() => fn(), 0);
      }
    },
    removeEventListener() {},
  };
}

// Setup global mocks
beforeEach(() => {
  // Mock MediaSource
  (globalThis as Record<string, unknown>).MediaSource = vi.fn(() => createMockMediaSource());

  // Mock AudioContext
  const mockAnalyser = {
    fftSize: 256,
    smoothingTimeConstant: 0.7,
    frequencyBinCount: 128,
    connect: vi.fn(),
    getByteFrequencyData: vi.fn((arr: Uint8Array) => {
      // Fill with some data to simulate audio
      for (let i = 0; i < arr.length; i++) {
        arr[i] = 128;
      }
    }),
  };

  (globalThis as Record<string, unknown>).AudioContext = vi.fn(() => ({
    state: "running",
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    destination: {},
    createAnalyser: vi.fn(() => mockAnalyser),
    createMediaElementSource: vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
  }));

  // Mock URL.createObjectURL/revokeObjectURL
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-url");
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StreamingTTS", () => {
  it("creates without errors", () => {
    const tts = new StreamingTTS("http://localhost:8000");
    expect(tts).toBeDefined();
    expect(tts.isSpeaking()).toBe(false);
    tts.destroy();
  });

  it("getOutputVolume returns 0 when not speaking", () => {
    const tts = new StreamingTTS("http://localhost:8000");
    expect(tts.getOutputVolume()).toBe(0);
    tts.destroy();
  });

  it("stop() increments generation to invalidate in-flight requests", () => {
    const tts = new StreamingTTS("http://localhost:8000");

    // Start a speak call that will be cancelled
    const fetchMock = vi.fn(() =>
      new Promise<never>(() => {
        // Never resolves — simulates in-flight request
      }),
    );
    globalThis.fetch = fetchMock;

    // Fire and forget
    tts.speak("Hello world");

    // Stop should cancel it
    tts.stop();
    expect(tts.isSpeaking()).toBe(false);

    tts.destroy();
  });

  it("stop() cleans up audio element", () => {
    const tts = new StreamingTTS("http://localhost:8000");

    // Simulate that an audio element exists
    tts.stop();

    // Should not throw and should be safe to call multiple times
    tts.stop();
    expect(tts.isSpeaking()).toBe(false);

    tts.destroy();
  });

  it("destroy() cleans up AudioContext", () => {
    const tts = new StreamingTTS("http://localhost:8000");

    // Force AudioContext creation by accessing getOutputVolume after a speak attempt
    tts.destroy();

    // Should be safe to call multiple times
    tts.destroy();
    expect(tts.getOutputVolume()).toBe(0);
  });

  it("speak() calls fetch with correct URL and body", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        body: null,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tts = new StreamingTTS("http://localhost:8000");
    const onEnd = vi.fn();

    await tts.speak("Hello world", undefined, onEnd);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/tts/stream",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello world" }),
      }),
    );

    // onEnd should be called on error
    expect(onEnd).toHaveBeenCalled();

    tts.destroy();
  });

  it("speak() skips stale responses when generation changes", async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tts = new StreamingTTS("http://localhost:8000");
    const onStart = vi.fn();
    const onEnd = vi.fn();

    // Start speaking
    const speakPromise = tts.speak("Hello", onStart, onEnd);

    // Stop before fetch resolves (increments generation)
    tts.stop();

    // Resolve the fetch — should be ignored due to generation mismatch
    if (resolveFetch) {
      (resolveFetch as (value: unknown) => void)({
        ok: true,
        status: 200,
        body: new ReadableStream(),
      });
    }

    await speakPromise;

    // onStart should NOT have been called since we stopped
    expect(onStart).not.toHaveBeenCalled();

    tts.destroy();
  });
});
