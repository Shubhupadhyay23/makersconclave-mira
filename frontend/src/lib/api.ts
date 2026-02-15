import type { OnboardingData, RecommendationResponse } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const API_BASE =
  process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:8000";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  poke_id: string | null;
}

export interface QueueInfo {
  queue_id: string;
  position: number;
  status: string;
  total_ahead: number;
}

export function googleLogin(code: string, redirectUri: string = "postmessage") {
  return request<UserProfile>("/auth/google", {
    method: "POST",
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });
}

export function updateProfile(userId: string, name: string, phone?: string) {
  const payload: { user_id: string; name: string; phone?: string } = {
    user_id: userId,
    name,
  };
  if (phone !== undefined) payload.phone = phone;
  return request<UserProfile>("/auth/profile", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function uploadSelfie(userId: string, selfieBase64: string) {
  return request<UserProfile>("/auth/selfie", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, selfie_base64: selfieBase64 }),
  });
}

export function joinQueue(userId: string) {
  return request<QueueInfo>("/queue/join", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
}

export function getQueueStatus(userId: string) {
  return request<QueueInfo>(`/queue/status/${userId}`);
}

export function leaveQueue(userId: string) {
  return request<{ status: string }>(`/queue/leave/${userId}`, {
    method: "POST",
  });
}

export function getUser(userId: string) {
  return request<UserProfile>(`/users/${userId}`);
}

export interface Purchase {
  brand: string;
  merchant: string | null;
  item_name: string;
  category: string | null;
  price: number | null;
  date: string | null;
  order_status: string | null;
}

export interface StyleProfile {
  brands: string[];
  price_range: { min: number; max: number; avg: number };
  style_tags: string[];
  narrative_summary: string | null;
}

export interface ScrapeResult {
  purchases: Purchase[];
  brand_freq: Record<string, number>;
  profile: StyleProfile;
}

export function startScrape(userId: string) {
  return request<{ status: string }>("/api/scrape/start", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
}

export async function fetchRecommendations(
  sessionId: string
): Promise<RecommendationResponse> {
  const res = await fetch(
    `${API_BASE}/api/sessions/${sessionId}/recommendations`,
    { method: "POST" }
  );
  return res.json();
}

export async function submitReaction(
  outfitId: string,
  reaction: "liked" | "disliked" | "skipped"
): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/api/outfits/${outfitId}/reaction`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reaction }),
  });
  return res.json();
}

export async function submitOnboarding(
  userId: string,
  data: OnboardingData
): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/api/users/${userId}/onboarding`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

// --- Queue control APIs ---

export function skipQueueUser(userId: string) {
  return request<{ status: string }>(`/queue/skip/${userId}`, {
    method: "POST",
  });
}

export function advanceQueue() {
  return request<{ status: string; active_user?: { id: string; name: string } }>(
    "/queue/advance",
    { method: "POST" }
  );
}

export function reorderQueue(userIds: string[]) {
  return request<{ status: string }>("/queue/reorder", {
    method: "PATCH",
    body: JSON.stringify({ user_ids: userIds }),
  });
}

export function startMirrorSession(userId: string) {
  return request<{ status: string }>("/queue/start-session", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
}

// --- Admin APIs ---

export interface AdminQueueEntry {
  id: string;
  user_id: string;
  name: string;
  position: number;
  status: string;
  joined_at: string;
}

export interface AdminSessionInfo {
  user_id: string;
  name: string;
  session_id: string | null;
  api_calls: number;
  items_shown: number;
  items_liked: number;
}

export interface BoothStats {
  total_users_today: number;
  avg_session_seconds: number;
  total_items_shown: number;
  total_items_liked: number;
}

export function getAdminQueue() {
  return request<AdminQueueEntry[]>("/admin/queue");
}

export function getAdminSession() {
  return request<AdminSessionInfo | null>("/admin/session");
}

export function getBoothStats() {
  return request<BoothStats>("/admin/stats");
}

export function forceEndSession() {
  return request<{ status: string }>("/admin/force-end", {
    method: "POST",
  });
}

export function clearQueue() {
  return request<{ status: string }>("/admin/clear-queue", {
    method: "POST",
  });
}

// --- STT Config APIs ---

export interface STTConfig {
  utterance_end_ms: number;
  model: string;
  smart_format: boolean;
}

export function getSTTConfig() {
  return request<STTConfig>("/admin/stt-config");
}

export function updateSTTConfig(config: Partial<STTConfig>) {
  return request<STTConfig>("/admin/stt-config", {
    method: "POST",
    body: JSON.stringify(config),
  });
}
