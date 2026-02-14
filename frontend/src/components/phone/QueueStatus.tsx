"use client";

import { useEffect, useState } from "react";
import { getQueueStatus, joinQueue, QueueInfo } from "@/lib/api";

interface QueueStatusProps {
  userId: string;
}

export default function QueueStatus({ userId }: QueueStatusProps) {
  const [queue, setQueue] = useState<QueueInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval>;

    async function init() {
      try {
        const info = await joinQueue(userId);
        if (!cancelled) setQueue(info);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to join queue");
      }
    }

    init();

    // Poll every 5 seconds
    timer = setInterval(async () => {
      try {
        const info = await getQueueStatus(userId);
        if (!cancelled) setQueue(info);
      } catch {
        // Ignore polling errors
      }
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [userId]);

  if (error) {
    return (
      <div style={{ textAlign: "center", color: "#c00" }}>
        <p>{error}</p>
      </div>
    );
  }

  if (!queue) {
    return (
      <div style={{ textAlign: "center", color: "#666" }}>
        <p>Joining the queue...</p>
      </div>
    );
  }

  if (queue.status === "active") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: "50%",
            background: "#22c55e",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 36,
          }}
        >
          ✓
        </div>
        <h2 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>It&apos;s your turn!</h2>
        <p style={{ color: "#666", margin: 0 }}>Head to the mirror to begin your session.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
      <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>You&apos;re in the queue</h2>
      <div
        style={{
          width: 100,
          height: 100,
          borderRadius: "50%",
          background: "#f4f4f5",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 40,
          fontWeight: 700,
        }}
      >
        {queue.position}
      </div>
      <p style={{ color: "#666", margin: 0, textAlign: "center" }}>
        {queue.total_ahead === 0
          ? "You're next! Hang tight."
          : `${queue.total_ahead} ${queue.total_ahead === 1 ? "person" : "people"} ahead of you`}
      </p>
      <p style={{ color: "#999", fontSize: 14, margin: 0 }}>
        This page updates automatically.
      </p>
    </div>
  );
}
