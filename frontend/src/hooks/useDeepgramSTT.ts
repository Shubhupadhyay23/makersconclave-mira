"use client";

import { useCallback, useRef, useState } from "react";

const DEEPGRAM_API_KEY = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY || "";
const DEEPGRAM_WS_URL =
  "wss://api.deepgram.com/v1/listen?" +
  "model=nova-2&smart_format=true&interim_results=true" +
  "&vad_events=true&utterance_end_ms=1500" +
  "&encoding=linear16&sample_rate=16000";

const MAX_RECONNECTS = 3;

export interface UseDeepgramSTTReturn {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  startListening: () => void;
  stopListening: () => void;
}

export function useDeepgramSTT(): UseDeepgramSTTReturn {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const resumeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectCountRef = useRef(0);

  const cleanup = useCallback(() => {
    if (resumeIntervalRef.current) {
      clearInterval(resumeIntervalRef.current);
      resumeIntervalRef.current = null;
    }
    processorRef.current?.disconnect();
    processorRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;
    reconnectCountRef.current = 0;
    setIsListening(false);
    setInterimTranscript("");
  }, []);

  const connectWebSocket = useCallback(
    (stream: MediaStream) => {
      if (!DEEPGRAM_API_KEY) {
        console.warn("[DeepgramSTT] No API key configured");
        return;
      }

      const ws = new WebSocket(DEEPGRAM_WS_URL, ["token", DEEPGRAM_API_KEY]);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[MirrorV2:STT] Connected to Deepgram");
        setIsListening(true);
        reconnectCountRef.current = 0;

        // Clean up old audio pipeline if reconnecting
        if (resumeIntervalRef.current) {
          clearInterval(resumeIntervalRef.current);
          resumeIntervalRef.current = null;
        }
        processorRef.current?.disconnect();
        audioCtxRef.current?.close().catch(() => {});

        // Create fresh audio pipeline: mic → AudioContext → ScriptProcessor → WebSocket
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const float32 = e.inputBuffer.getChannelData(0);
          // Convert Float32 PCM to Int16 PCM
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          ws.send(int16.buffer);
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);

        // Periodically resume AudioContext if browser suspends it (tab switch / idle)
        resumeIntervalRef.current = setInterval(() => {
          if (audioCtx.state === "suspended") {
            audioCtx.resume().catch(() => {});
          }
        }, 3000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Handle utterance end — clear interim
          if (data.type === "UtteranceEnd") {
            setInterimTranscript("");
            return;
          }

          const alt = data.channel?.alternatives?.[0];
          if (!alt) return;

          const text = alt.transcript;
          if (!text) return;

          if (data.is_final) {
            console.log("[STT] Final transcript:", text);
            setTranscript(text);
            setInterimTranscript("");
          } else {
            setInterimTranscript(text);
          }
        } catch {
          console.warn("[MirrorV2:STT] Non-JSON message received");
        }
      };

      ws.onclose = (event) => {
        console.warn("[MirrorV2:STT] Disconnected:", event.reason || `code=${event.code}`);
        // Exponential backoff reconnect (max 3 attempts)
        if (reconnectCountRef.current < MAX_RECONNECTS && streamRef.current) {
          reconnectCountRef.current += 1;
          const delay = Math.min(1000 * Math.pow(2, reconnectCountRef.current - 1), 5000);
          console.warn(`[MirrorV2:STT] Reconnecting, attempt: ${reconnectCountRef.current}/${MAX_RECONNECTS} in ${delay}ms`);
          setTimeout(() => {
            if (streamRef.current) {
              connectWebSocket(streamRef.current);
            }
          }, delay);
        } else if (reconnectCountRef.current >= MAX_RECONNECTS) {
          console.error("[MirrorV2:STT] Max reconnects reached, STT offline");
          setIsListening(false);
        } else {
          setIsListening(false);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    },
    [cleanup],
  );

  const startListening = useCallback(async () => {
    if (wsRef.current) return;
    reconnectCountRef.current = 0;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      connectWebSocket(stream);
    } catch (err) {
      console.error("[MirrorV2:STT] Microphone access failed:", err instanceof Error ? err.message : err);
    }
  }, [connectWebSocket]);

  const stopListening = useCallback(() => {
    cleanup();
  }, [cleanup]);

  return { isListening, transcript, interimTranscript, startListening, stopListening };
}
