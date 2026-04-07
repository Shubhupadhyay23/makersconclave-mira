"use client";

import { useEffect, useState, useRef } from "react";
import { getQueueStatus, joinQueue, leaveQueue, QueueInfo } from "@/lib/api";

interface QueueStatusProps {
  userId: string;
  onLeave?: () => void;
}

export default function QueueStatus({ userId, onLeave }: QueueStatusProps) {
  const [queue, setQueue] = useState<QueueInfo | null>(null);
  const [error, setError] = useState("");
  const [leaving, setLeaving] = useState(false);
  const firedRef = useRef(false);

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



  async function handleLeave() {
    setLeaving(true);
    try {
      await leaveQueue(userId);
      onLeave?.();
    } catch {
      setLeaving(false);
      setError("Failed to leave queue. Please try again.");
    }
  }

  if (error) {
    return (
      <div className="text-center text-red-500">
        <p>{error}</p>
      </div>
    );
  }

  if (!queue) {
    return (
      <div className="text-center text-zinc-500">
        <p>Joining the queue...</p>
      </div>
    );
  }

  if (queue.status === "active") {
    return (
      <div className="flex flex-col items-center gap-3">
        <div className="w-14 h-14 rounded-full bg-green-500 flex items-center justify-center text-white text-2xl">
          ✓
        </div>
        <h2 className="text-xl font-bold">It&apos;s your turn!</h2>
        <p className="text-zinc-500 text-sm">Head to the mirror to begin your session.</p>
        <button
          onClick={handleLeave}
          disabled={leaving}
          className="mt-2 text-xs text-zinc-400 hover:text-zinc-600 transition-colors disabled:opacity-50"
        >
          {leaving ? "Leaving..." : "Leave Queue"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <h2 className="text-lg font-bold">You&apos;re in the queue</h2>
      <div className="w-18 h-18 rounded-full bg-zinc-100 flex items-center justify-center text-3xl font-bold" style={{ width: 72, height: 72 }}>
        {queue.position}
      </div>
      <p className="text-zinc-500 text-center text-sm">
        {queue.total_ahead === 0
          ? "You're next! Hang tight."
          : `${queue.total_ahead} ${queue.total_ahead === 1 ? "person" : "people"} ahead of you`}
      </p>
      <p className="text-zinc-400 text-xs">
        This page updates automatically.
      </p>
      <button
        onClick={handleLeave}
        disabled={leaving}
        className="mt-1 text-xs text-zinc-400 hover:text-zinc-600 transition-colors disabled:opacity-50"
      >
        {leaving ? "Leaving..." : "Leave Queue"}
      </button>
    </div>
  );
}
