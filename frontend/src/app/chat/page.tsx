"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { socket } from "@/lib/socket";

type MessageRole = "user" | "mira" | "system";

interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
}

interface ProductItem {
  title: string;
  price: string;
  source: string;
  image_url: string;
  link: string;
  rating?: number;
  rating_count?: number;
}

interface ProductCard {
  id: string;
  query: string;
  items: ProductItem[];
}

const DEMO_USER_ID = "00000000-0000-4000-a000-000000000001";

export default function ChatPage() {
  const [userId, setUserId] = useState(DEMO_USER_ID);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [products, setProducts] = useState<ProductCard[]>([]);
  const [input, setInput] = useState("");
  const [sessionActive, setSessionActive] = useState(false);
  const [connected, setConnected] = useState(false);
  const miraBufferRef = useRef("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, products, scrollToBottom]);

  // Socket connection & listeners
  useEffect(() => {
    socket.connect();

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("mira_speech", (data: { text: string; is_chunk: boolean }) => {
      miraBufferRef.current += data.text;
      const currentText = miraBufferRef.current;

      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "mira" && last.id.startsWith("mira-stream-")) {
          return [
            ...prev.slice(0, -1),
            { ...last, text: currentText },
          ];
        }
        return [
          ...prev,
          { id: `mira-stream-${Date.now()}`, role: "mira", text: currentText },
        ];
      });
    });

    socket.on("tool_result", (data: { type: string; query: string; items: ProductItem[] }) => {
      if (data.type === "clothing_results" && data.items?.length > 0) {
        setProducts((prev) => [
          ...prev,
          { id: `product-${Date.now()}`, query: data.query, items: data.items },
        ]);
      }
    });

    socket.on("session_ended", (data: { summary: string; stats: { items_shown: number; likes: number; dislikes: number } }) => {
      setSessionActive(false);
      miraBufferRef.current = "";
      setMessages((prev) => [
        ...prev,
        {
          id: `sys-${Date.now()}`,
          role: "system",
          text: `Session ended. ${data.summary || ""} (Items shown: ${data.stats.items_shown}, Likes: ${data.stats.likes}, Dislikes: ${data.stats.dislikes})`,
        },
      ]);
    });

    socket.on("session_recap", (data: { summary?: string; liked_items?: string[] }) => {
      const parts: string[] = [];
      if (data.summary) parts.push(data.summary);
      if (data.liked_items?.length) parts.push(`Liked items: ${data.liked_items.join(", ")}`);
      if (parts.length > 0) {
        setMessages((prev) => [
          ...prev,
          { id: `recap-${Date.now()}`, role: "system", text: `Recap: ${parts.join(" | ")}` },
        ]);
      }
    });

    socket.on("debug_system_prompt", (data: { prompt: string }) => {
      setMessages((prev) => [
        ...prev,
        { id: `prompt-${Date.now()}`, role: "system", text: `__PROMPT__${data.prompt}` },
      ]);
    });

    socket.on("session_error", (data: { error: string }) => {
      setSessionActive(false);
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "system", text: `Error: ${data.error}` },
      ]);
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("mira_speech");
      socket.off("tool_result");
      socket.off("session_ended");
      socket.off("session_recap");
      socket.off("debug_system_prompt");
      socket.off("session_error");
      socket.disconnect();
    };
  }, []);

  const joinRoom = useCallback(() => {
    socket.emit("join_room", { user_id: userId });
    setMessages((prev) => [
      ...prev,
      { id: `sys-${Date.now()}`, role: "system", text: `Joined room as ${userId}` },
    ]);
  }, [userId]);

  const startSession = useCallback(() => {
    miraBufferRef.current = "";
    socket.emit("start_session", { user_id: userId });
    setSessionActive(true);
    setMessages((prev) => [
      ...prev,
      { id: `sys-${Date.now()}`, role: "system", text: "Session started..." },
    ]);
    setProducts([]);
  }, [userId]);

  const endSession = useCallback(() => {
    socket.emit("end_session", { user_id: userId });
    setMessages((prev) => [
      ...prev,
      { id: `sys-${Date.now()}`, role: "system", text: "Ending session..." },
    ]);
  }, [userId]);

  const sendMessage = useCallback(() => {
    if (!input.trim()) return;
    const text = input.trim();
    setInput("");
    miraBufferRef.current = "";
    setMessages((prev) => [
      ...prev,
      { id: `user-${Date.now()}`, role: "user", text },
    ]);
    socket.emit("mirror_event", {
      user_id: userId,
      event: { type: "voice", transcript: text },
    });
  }, [input, userId]);

  const sendGesture = useCallback(
    (gesture: string, label: string) => {
      miraBufferRef.current = "";
      setMessages((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, role: "user", text: `[${label}]` },
      ]);
      socket.emit("mirror_event", {
        user_id: userId,
        event: { type: "gesture", gesture },
      });
    },
    [userId]
  );

  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#0a0a0a",
        color: "#e0e0e0",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid #222",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h1 style={{ margin: 0, fontSize: "1.25rem", color: "#fff" }}>
            Chat with Mira
          </h1>
          <span
            style={{
              fontSize: "0.75rem",
              color: connected ? "#4caf50" : "#f44336",
            }}
          >
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>

        {/* User ID + Join */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="User ID (UUID)"
            style={{
              flex: 1,
              padding: "6px 10px",
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: 6,
              color: "#e0e0e0",
              fontSize: "0.8rem",
            }}
          />
          <button onClick={joinRoom} style={btnStyle("#6b21a8")}>
            Join
          </button>
        </div>

        {/* Session controls */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={startSession}
            disabled={sessionActive}
            style={btnStyle(sessionActive ? "#333" : "#16a34a")}
          >
            Start Session
          </button>
          <button
            onClick={endSession}
            disabled={!sessionActive}
            style={btnStyle(!sessionActive ? "#333" : "#dc2626")}
          >
            End Session
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              alignSelf:
                msg.role === "user"
                  ? "flex-end"
                  : msg.role === "system"
                  ? "center"
                  : "flex-start",
              maxWidth: msg.role === "system" ? "90%" : "80%",
              padding: "10px 14px",
              borderRadius: 12,
              fontSize: "0.9rem",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              ...(msg.role === "user"
                ? { background: "#6b21a8", color: "#fff" }
                : msg.role === "mira"
                ? { background: "#1a1a2e", color: "#e0e0e0", border: "1px solid #2a2a4e" }
                : { background: "#111", color: "#888", fontSize: "0.8rem", fontStyle: "italic" }),
            }}
          >
            {msg.role === "mira" && (
              <div style={{ fontSize: "0.7rem", color: "#9b59b6", marginBottom: 4, fontWeight: 600 }}>
                Mira
              </div>
            )}
            {msg.text.startsWith("__PROMPT__") ? (
              <details style={{ cursor: "pointer" }}>
                <summary style={{ fontStyle: "normal", fontWeight: 600, color: "#aaa" }}>
                  System Prompt (click to expand)
                </summary>
                <pre style={{
                  marginTop: 8,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: "0.75rem",
                  color: "#999",
                  maxHeight: 400,
                  overflowY: "auto",
                  background: "#0a0a0a",
                  padding: 8,
                  borderRadius: 6,
                }}>
                  {msg.text.slice("__PROMPT__".length)}
                </pre>
              </details>
            ) : (
              msg.text
            )}
          </div>
        ))}

        {/* Product cards */}
        {products.map((card) => (
          <div key={card.id} style={{ alignSelf: "flex-start", maxWidth: "90%" }}>
            <div style={{ fontSize: "0.75rem", color: "#888", marginBottom: 6 }}>
              Results for &quot;{card.query}&quot;
            </div>
            <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
              {card.items.map((item, i) => (
                <a
                  key={i}
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    minWidth: 160,
                    background: "#1a1a2e",
                    border: "1px solid #2a2a4e",
                    borderRadius: 10,
                    padding: 10,
                    textDecoration: "none",
                    color: "#e0e0e0",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {item.image_url && (
                    <img
                      src={item.image_url}
                      alt={item.title}
                      style={{
                        width: "100%",
                        height: 120,
                        objectFit: "contain",
                        borderRadius: 6,
                        background: "#fff",
                      }}
                    />
                  )}
                  <div style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                    {item.title.length > 50 ? item.title.slice(0, 50) + "..." : item.title}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "#9b59b6", fontWeight: 700 }}>
                    {item.price}
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "#888" }}>
                    {item.source}
                    {item.rating ? ` | ${item.rating}★` : ""}
                  </div>
                </a>
              ))}
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Gesture buttons */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 12,
          padding: "8px 20px",
          borderTop: "1px solid #222",
        }}
      >
        {[
          { gesture: "thumbs_up", label: "Thumbs Up", emoji: "\ud83d\udc4d" },
          { gesture: "thumbs_down", label: "Thumbs Down", emoji: "\ud83d\udc4e" },
          { gesture: "swipe_left", label: "Swipe Left", emoji: "\u2b05\ufe0f" },
          { gesture: "swipe_right", label: "Swipe Right", emoji: "\u27a1\ufe0f" },
        ].map(({ gesture, label, emoji }) => (
          <button
            key={gesture}
            onClick={() => sendGesture(gesture, label)}
            disabled={!sessionActive}
            title={label}
            style={{
              padding: "8px 16px",
              fontSize: "1.3rem",
              background: sessionActive ? "#1a1a2e" : "#111",
              border: "1px solid #2a2a4e",
              borderRadius: 8,
              cursor: sessionActive ? "pointer" : "default",
              opacity: sessionActive ? 1 : 0.4,
            }}
          >
            {emoji}
          </button>
        ))}
      </div>

      {/* Text input */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "12px 20px 20px",
          borderTop: "1px solid #222",
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          placeholder={sessionActive ? "Type a message..." : "Start a session first"}
          disabled={!sessionActive}
          style={{
            flex: 1,
            padding: "10px 14px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: 8,
            color: "#e0e0e0",
            fontSize: "0.9rem",
            opacity: sessionActive ? 1 : 0.5,
          }}
        />
        <button
          onClick={sendMessage}
          disabled={!sessionActive || !input.trim()}
          style={btnStyle(!sessionActive || !input.trim() ? "#333" : "#6b21a8")}
        >
          Send
        </button>
      </div>
    </main>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: "8px 16px",
    background: bg,
    color: "#fff",
    border: "none",
    borderRadius: 6,
    cursor: bg === "#333" ? "default" : "pointer",
    fontSize: "0.85rem",
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
}
