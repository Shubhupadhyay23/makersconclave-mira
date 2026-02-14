const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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

export function updateProfile(userId: string, name: string, phone: string) {
  return request<UserProfile>("/auth/profile", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, name, phone }),
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
