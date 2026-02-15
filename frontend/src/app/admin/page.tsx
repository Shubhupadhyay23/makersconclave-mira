"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getAdminQueue,
  getAdminSession,
  getBoothStats,
  getSTTConfig,
  updateSTTConfig,
  skipQueueUser,
  forceEndSession,
  clearQueue,
  startMirrorSession,
  advanceQueue,
  type AdminQueueEntry,
  type AdminSessionInfo,
  type BoothStats,
  type STTConfig,
} from "@/lib/api";

const POLL_INTERVAL = 10_000;

export default function AdminPage() {
  const [queue, setQueue] = useState<AdminQueueEntry[]>([]);
  const [session, setSession] = useState<AdminSessionInfo | null>(null);
  const [stats, setStats] = useState<BoothStats | null>(null);
  const [sttConfig, setSttConfig] = useState<STTConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [q, s, st, stt] = await Promise.all([
        getAdminQueue(),
        getAdminSession(),
        getBoothStats(),
        getSTTConfig(),
      ]);
      setQueue(q);
      setSession(s);
      setStats(st);
      setSttConfig(stt);
    } catch (err) {
      console.error("[Admin] Refresh failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleSkip = useCallback(
    async (userId: string) => {
      await skipQueueUser(userId);
      refresh();
    },
    [refresh]
  );

  const handleForceEnd = useCallback(async () => {
    await forceEndSession();
    refresh();
  }, [refresh]);

  const handleStartSession = useCallback(
    async (userId: string) => {
      await startMirrorSession(userId);
      refresh();
    },
    [refresh]
  );

  const handleAdvance = useCallback(async () => {
    await advanceQueue();
    refresh();
  }, [refresh]);

  const handleClearQueue = useCallback(async () => {
    if (!confirm("Clear entire queue? This will end all active sessions.")) return;
    await clearQueue();
    refresh();
  }, [refresh]);

  if (loading) {
    return (
      <main className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <p className="text-zinc-400">Loading admin panel...</p>
      </main>
    );
  }

  const activeEntry = queue.find((q) => q.status === "active");
  const waitingEntries = queue.filter((q) => q.status === "waiting");

  return (
    <main className="min-h-screen bg-zinc-50 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold">Mirrorless Admin</h1>
          <div className="flex items-center gap-3">
            <button
              onClick={handleClearQueue}
              className="text-sm bg-red-100 text-red-700 px-3 py-1.5 rounded-lg font-medium hover:bg-red-200"
            >
              Clear Queue
            </button>
            <button
              onClick={refresh}
              className="text-sm text-zinc-500 hover:text-zinc-900 underline"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Booth Stats */}
        {stats && (
          <div className="grid grid-cols-4 gap-4 mb-8">
            <StatCard label="Users Today" value={stats.total_users_today} />
            <StatCard
              label="Avg Session"
              value={`${Math.round(stats.avg_session_seconds)}s`}
            />
            <StatCard label="Items Shown" value={stats.total_items_shown} />
            <StatCard label="Items Liked" value={stats.total_items_liked} />
          </div>
        )}

        {/* Current Session */}
        <section className="bg-white rounded-xl border border-zinc-200 p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Current Session</h2>
          {session ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{session.name}</p>
                <p className="text-sm text-zinc-500">
                  API calls: {session.api_calls} | Items: {session.items_shown} shown, {session.items_liked} liked
                </p>
              </div>
              <button
                onClick={handleForceEnd}
                className="bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-600"
              >
                Force End
              </button>
            </div>
          ) : activeEntry ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{activeEntry.name}</p>
                <p className="text-sm text-zinc-500">Waiting at mirror (no session started)</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleStartSession(activeEntry.user_id)}
                  className="bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-600"
                >
                  Start Session
                </button>
                <button
                  onClick={() => handleSkip(activeEntry.user_id)}
                  className="bg-zinc-200 text-zinc-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-zinc-300"
                >
                  Skip
                </button>
              </div>
            </div>
          ) : (
            <p className="text-zinc-400">No active session</p>
          )}
        </section>

        {/* Queue */}
        <section className="bg-white rounded-xl border border-zinc-200 p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">
              Queue ({waitingEntries.length} waiting)
            </h2>
            {waitingEntries.length > 0 && !activeEntry && (
              <button
                onClick={handleAdvance}
                className="text-sm text-blue-600 hover:underline"
              >
                Advance Next
              </button>
            )}
          </div>
          {waitingEntries.length === 0 ? (
            <p className="text-zinc-400">Queue is empty</p>
          ) : (
            <div className="divide-y divide-zinc-100">
              {waitingEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between py-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center text-sm font-medium">
                      {entry.position}
                    </span>
                    <span className="font-medium">{entry.name}</span>
                  </div>
                  <button
                    onClick={() => handleSkip(entry.user_id)}
                    className="text-sm text-red-500 hover:underline"
                  >
                    Skip
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* STT Settings */}
        {sttConfig && (
          <STTSettings config={sttConfig} onChange={setSttConfig} />
        )}
      </div>
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white rounded-xl border border-zinc-200 p-4 text-center">
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs text-zinc-500 mt-1">{label}</p>
    </div>
  );
}

const STT_MODELS = [
  { value: "nova-2", label: "Nova 2 (default)" },
  { value: "nova-2-general", label: "Nova 2 General" },
  { value: "nova-2-phonecall", label: "Nova 2 Phone Call" },
  { value: "nova-2-meeting", label: "Nova 2 Meeting" },
];

function STTSettings({
  config,
  onChange,
}: {
  config: STTConfig;
  onChange: (config: STTConfig) => void;
}) {
  const [localUtterance, setLocalUtterance] = useState(config.utterance_end_ms);
  const [saving, setSaving] = useState(false);

  const save = useCallback(
    async (patch: Partial<STTConfig>) => {
      setSaving(true);
      try {
        const updated = await updateSTTConfig(patch);
        onChange(updated);
      } catch (err) {
        console.error("[Admin] STT config update failed:", err);
      } finally {
        setSaving(false);
      }
    },
    [onChange],
  );

  return (
    <section className="bg-white rounded-xl border border-zinc-200 p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">STT Settings</h2>
        {saving && <span className="text-xs text-zinc-400">Saving...</span>}
      </div>

      <div className="space-y-5">
        {/* Utterance End */}
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">
            Utterance End: {localUtterance}ms
          </label>
          <input
            type="range"
            min={500}
            max={3000}
            step={100}
            value={localUtterance}
            onChange={(e) => setLocalUtterance(Number(e.target.value))}
            onMouseUp={() => save({ utterance_end_ms: localUtterance })}
            onTouchEnd={() => save({ utterance_end_ms: localUtterance })}
            className="w-full accent-blue-500"
          />
          <div className="flex justify-between text-xs text-zinc-400 mt-1">
            <span>500ms (fast)</span>
            <span>3000ms (slow)</span>
          </div>
        </div>

        {/* Model */}
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">
            Model
          </label>
          <select
            value={config.model}
            onChange={(e) => save({ model: e.target.value })}
            className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm bg-white"
          >
            {STT_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {/* Smart Format */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-700">Smart Format</p>
            <p className="text-xs text-zinc-400">
              Auto-punctuation, numerals, formatting
            </p>
          </div>
          <button
            onClick={() => save({ smart_format: !config.smart_format })}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              config.smart_format ? "bg-blue-500" : "bg-zinc-300"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                config.smart_format ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>
    </section>
  );
}
