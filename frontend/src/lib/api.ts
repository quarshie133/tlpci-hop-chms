/**
 * ChurchMS API client — wraps fetch with auth token management.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1";

export interface ApiError {
  status: number;
  detail: string;
  fieldErrors?: Record<string, string[] | string>;
  /** Machine-readable error code from the API (e.g. "confirmation_required"). */
  code?: string;
  /** Full JSON error body, for endpoints that return extra context. */
  body?: Record<string, unknown>;
}

/** Fired on `window` when the access token was refreshed (detail: new token). */
export const AUTH_TOKEN_REFRESHED = "churchms:token-refreshed";
/** Fired on `window` when the session can no longer be refreshed. */
export const AUTH_SESSION_EXPIRED = "churchms:session-expired";

let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const refresh = localStorage.getItem("refresh_token");
  if (!refresh) return null;
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE}/auth/token/refresh/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh }),
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const data: { access: string; refresh?: string } = await res.json();
        localStorage.setItem("access_token", data.access);
        if (data.refresh) localStorage.setItem("refresh_token", data.refresh);
        window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED, { detail: data.access }));
        return data.access;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function toApiError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => ({}));
  let detail = body?.detail;
  if (!detail && typeof body === "object" && body !== null) {
    const messages = Object.entries(body)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("; ");
    if (messages) detail = messages;
  }
  return {
    status: res.status,
    detail: detail || res.statusText || "Request failed",
    fieldErrors: typeof body === "object" && body !== null && !body.detail ? body : undefined,
    code: typeof body?.code === "string" ? body.code : undefined,
    body: typeof body === "object" && body !== null ? body : undefined,
  };
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
  retried = false
): Promise<T> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options.headers as Record<string, string>) ?? {}),
  };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    throw {
      status: 0,
      detail: "Unable to reach the server. Check your connection and try again.",
    } as ApiError;
  }

  if (res.status === 401 && token && !retried) {
    const fresh = await refreshAccessToken();
    if (fresh) return request<T>(path, options, fresh, true);
    if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED));
  }

  if (!res.ok) throw await toApiError(res);

  if (res.status === 204) return undefined as T;
  return res.json();
}

/** Human-readable message for any thrown value (ApiError, Error, or unknown). */
export function errorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (err && typeof err === "object") {
    const e = err as Partial<ApiError> & { message?: string };
    if (e.status === 403) return "You don't have permission to perform this action.";
    if (typeof e.detail === "string" && e.detail) return e.detail;
    if (typeof e.message === "string" && e.message) return e.message;
  }
  return fallback;
}

/** First error message for a specific form field returned by DRF, if any. */
export function fieldError(err: unknown, field: string): string | undefined {
  const fe = (err as ApiError | undefined)?.fieldErrors;
  const v = fe?.[field];
  if (!v) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

// ─── Auth ──────────────────────────────────────────────────────────────────
export const authApi = {
  login: (email: string, password: string) =>
    request<{ access: string; refresh: string }>("/auth/token/", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  refresh: (refresh: string) =>
    request<{ access: string }>("/auth/token/refresh/", {
      method: "POST",
      body: JSON.stringify({ refresh }),
    }),
  me: (token: string) =>
    request<User>("/auth/me/", {}, token),
  updateProfile: (token: string, data: Partial<User>) =>
    request<User>("/auth/me/", { method: "PATCH", body: JSON.stringify(data) }, token),
  changePassword: (token: string, data: { old_password: string; new_password: string }) =>
    request("/auth/change-password/", { method: "POST", body: JSON.stringify(data) }, token),
};

// ─── Types ──────────────────────────────────────────────────────────────────
export type UserRole = "super_admin" | "church_admin" | "pastor" | "staff" | "volunteer" | "member";

export interface User {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  full_name: string;
  role: string;
  phone: string;
  avatar: string | null;
  is_active?: boolean;
  date_joined?: string;
}

export interface PaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface Family {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postal_code: string;
  notes: string;
  member_count: number;
}

export interface Member {
  id: string;
  full_name: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_mobile: string;
  status: string;
  life_stage: string;
  photo: string | null;
  age: number | null;
  family_name: string | null;
  membership_date: string | null;
  created_at: string;
}

/** Full member record returned by the detail endpoint. */
export interface MemberDetail extends Omit<Member, "family_name"> {
  family: Family | null;
  family_id?: string | null;
  middle_name: string;
  preferred_name: string;
  gender: string;
  date_of_birth: string | null;
  marital_status: string;
  phone_home: string;
  phone_work: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postal_code: string;
  baptism_date: string | null;
  join_reason: string;
  how_did_you_hear: string;
  employer: string;
  occupation: string;
  spiritual_gifts: string;
  interests: string;
  notes: string;
  updated_at: string;
}

export interface MemberNote {
  id: string;
  member: string;
  note: string;
  created_by_user_id: number;
  created_at: string;
}

export interface Contribution {
  id: string;
  member: string | null;
  member_name: string | null;
  fund: string;
  fund_name: string;
  contribution_type: string;
  amount: string;
  currency: string;
  payment_method: string;
  reference_number?: string;
  check_number?: string;
  date: string;
  is_anonymous?: boolean;
  notes: string;
  created_at?: string;
}

export interface EventCategory {
  id: string;
  name: string;
  color: string;
  icon: string;
}

export interface Event {
  id: string;
  title: string;
  description: string;
  category: string | null;
  category_name: string | null;
  location: string;
  start_datetime: string;
  end_datetime: string;
  is_all_day: boolean;
  requires_rsvp: boolean;
  rsvp_count: number;
  max_attendees?: number | null;
  is_public?: boolean;
  cover_image: string | null;
}

export interface Series {
  id: string;
  title: string;
  description: string;
  sermon_count?: number;
  is_active: boolean;
}

export interface Sermon {
  id: string;
  series?: string | null;
  title: string;
  speaker: string;
  scripture_reference: string;
  description?: string;
  date: string;
  series_title: string | null;
  thumbnail: string | null;
  video_url: string;
  audio_url: string;
  is_published: boolean;
  views_count: number;
  tags: string[];
}

export interface GroupCategory {
  id: string;
  name: string;
  description: string;
}

export interface Group {
  id: string;
  name: string;
  category?: string | null;
  category_name: string | null;
  leader?: string | null;
  leader_name: string | null;
  member_count: number;
  is_active: boolean;
  is_open: boolean;
  cover_image: string | null;
  description: string;
  meeting_day?: string;
  meeting_time?: string | null;
  meeting_frequency?: string;
  meeting_location?: string;
  max_members?: number | null;
}

export interface GroupMembership {
  id: string;
  group: string;
  member: string;
  member_name: string;
  role: string;
  joined_date: string;
  is_active: boolean;
}

// ─── Resource factories ──────────────────────────────────────────────────────
function resource<T>(base: string) {
  return {
    list: (token: string, params = "") =>
      request<PaginatedResponse<T>>(`${base}?${params}`, {}, token),
    get: (token: string, id: string) =>
      request<T>(`${base}${id}/`, {}, token),
    create: (token: string, data: Partial<T> | Record<string, unknown>) =>
      request<T>(base, { method: "POST", body: JSON.stringify(data) }, token),
    update: (token: string, id: string, data: Partial<T> | Record<string, unknown>) =>
      request<T>(`${base}${id}/`, { method: "PATCH", body: JSON.stringify(data) }, token),
    remove: (token: string, id: string) =>
      request<void>(`${base}${id}/`, { method: "DELETE" }, token),
  };
}

/** Fetch every page of a list endpoint (bounded, for selectors and counts). */
export async function listAll<T>(
  list: (token: string, params?: string) => Promise<PaginatedResponse<T>>,
  token: string,
  params = "",
  maxPages = 10
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams(params);
    qs.set("page", String(page));
    qs.set("page_size", "200");
    const res = await list(token, qs.toString());
    out.push(...res.results);
    if (!res.next) break;
  }
  return out;
}

export interface Fund {
  id: string;
  name: string;
  description: string;
  goal_amount: string | null;
  total_received?: string;
  fulfillment_pct?: number | null;
  is_active: boolean;
}

export interface Pledge {
  id: string;
  member: string;
  member_name: string;
  fund: string;
  fund_name: string;
  total_amount: string;
  paid_amount: string;
  remaining_amount: string;
  fulfillment_pct: number;
  start_date: string;
  end_date: string;
  status: string;
  notes: string;
}

export const membersApi = {
  ...resource<Member>("/members/"),
  detail: (token: string, id: string) => request<MemberDetail>(`/members/${id}/`, {}, token),
  notes: (token: string, id: string) => request<MemberNote[]>(`/members/${id}/notes/`, {}, token),
  addNote: (token: string, id: string, note: string) =>
    request<MemberNote>(`/members/${id}/notes/`, { method: "POST", body: JSON.stringify({ note, member: id }) }, token),
};
export const familiesApi = resource<Family>("/members/families/");
export interface RSVP {
  id: string;
  event: string;
  member: string | null;
  member_name: string | null;
  guest_name: string;
  status: string;
  guest_count: number;
}

export const eventsApi = {
  ...resource<Event>("/events/"),
  rsvps: (token: string, id: string) => request<RSVP[]>(`/events/${id}/rsvps/`, {}, token),
};
export const eventCategoriesApi = resource<EventCategory>("/events/categories/");
export const sermonsApi = resource<Sermon>("/sermons/");
export const seriesApi = resource<Series>("/sermons/series/");
export const groupCategoriesApi = resource<GroupCategory>("/groups/categories/");
export const groupsApi = {
  ...resource<Group>("/groups/"),
  members: (token: string, id: string) =>
    request<GroupMembership[]>(`/groups/${id}/members/`, {}, token),
  addMember: (token: string, id: string, member: string, role = "member") =>
    request<GroupMembership>(
      `/groups/${id}/members/`,
      { method: "POST", body: JSON.stringify({ member, role, group: id }) },
      token
    ),
  removeMember: (token: string, id: string, membershipId: string) =>
    request<void>(`/groups/${id}/members/${membershipId}/`, { method: "DELETE" }, token),
};
export const fundsApi = resource<Fund>("/finance/funds/");
export const contributionsApi = resource<Contribution>("/finance/contributions/");
export const pledgesApi = resource<Pledge>("/finance/pledges/");

export interface FinanceSummary {
  this_month: string;
  this_year: string;
  all_time: string;
  by_type: Array<{ contribution_type: string; total: number | string; count: number }>;
  by_method?: Array<{ payment_method: string; total: number | string }>;
}

export const financeApi = {
  ...resource<Contribution>("/finance/contributions/"),
  summary: (token: string) =>
    request<FinanceSummary>("/finance/contributions/summary/", {}, token),
  monthlyTrend: (token: string) =>
    request<Array<{ month: string; total: number; count: number }>>(
      "/finance/contributions/monthly_trend/", {}, token
    ),
};

export interface ServiceType {
  id: string;
  name: string;
  description: string;
  default_day: string;
  is_active: boolean;
}

export interface ServiceRecord {
  id: string;
  date: string;
  actual_count: number;
  service_type?: string;
  service_type_name?: string;
  title?: string;
  expected_count?: number | null;
  notes?: string;
}

export interface AttendanceRecord {
  id: string;
  service: string;
  member: string | null;
  member_name: string | null;
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  is_first_time: boolean;
  check_in_time: string | null;
  notes: string;
  created_at: string;
}

export const serviceTypesApi = resource<ServiceType>("/attendance/service-types/");
export const attendanceRecordsApi = resource<AttendanceRecord>("/attendance/records/");
export const attendanceApi = {
  ...resource<ServiceRecord>("/attendance/"),
  trends: (token: string) =>
    request<Array<{ date: string; count: number; service_type__name: string }>>(
      "/attendance/trends/", {}, token
    ),
};

export interface MemberStats {
  total: number;
  active: number;
  visitors: number;
  inactive: number;
  by_life_stage: Array<{ life_stage: string; count: number }>;
  by_gender: Array<{ gender: string; count: number }>;
}

export const memberStatsApi = (token: string) =>
  request<MemberStats>("/members/stats/", {}, token);

export type AudienceSpec =
  | { type: "active" | "everyone" | "visitors" }
  | { type: "group"; group_id: string }
  | { type: "life_stage"; life_stage: string }
  | { type: "members"; member_ids: string[] }
  | { type: "phone"; phone: string; name?: string };

export interface Campaign {
  id: string;
  name: string;
  channel: string;
  status: string;
  recipient_count: number;
  sent_count: number;
  failed_count?: number;
  unknown_count?: number;
  skipped_count?: number;
  subject?: string;
  body?: string;
  sender_id?: string;
  include_name_in_sms?: boolean;
  recipients_filter?: AudienceSpec | Record<string, unknown>;
  audience_label?: string;
  dry_run?: boolean;
  last_error?: string;
  scheduled_at?: string | null;
  processing_started_at?: string | null;
  sent_at?: string | null;
  completed_at?: string | null;
  sent_by_user_id?: number | null;
  created_at: string;
}

export interface CampaignRecipient {
  id: string;
  member_id: string | null;
  name: string;
  address: string;
  status: string;
  provider_message_id: string;
  delivery_status: string;
  error_code: string;
  error_message: string;
  attempts: number;
  sent_at: string | null;
}

export interface CampaignAuditEntry {
  id: number;
  action: string;
  user_id: number | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface AudiencePreview {
  matched: number;
  recipients: number;
  invalid: number;
  missing_contact: number;
  duplicates_removed: number;
  invalid_sample: Array<{ member_id: string | null; name: string }>;
  segments_per_message?: number;
  encoding?: string;
  characters?: number;
  estimated_segments?: number;
  requires_confirmation: boolean;
  max_recipients: number;
}

export interface SmsConfig {
  provider: string;
  configured: boolean;
  api_key_configured: boolean;
  dry_run: boolean;
  sender_ids: string[];
  default_sender_id: string;
  large_broadcast_threshold: number;
  max_recipients: number;
  max_message_length: number;
}

const CAMPAIGNS = "/communications/campaigns/";
const post = (body?: unknown): RequestInit => ({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const communicationsApi = {
  ...resource<Campaign>(CAMPAIGNS),
  preview: (token: string, data: { channel: string; recipients_filter: AudienceSpec; body?: string; name?: string; include_name_in_sms?: boolean }) =>
    request<AudiencePreview>(`${CAMPAIGNS}preview/`, post(data), token),
  send: (token: string, id: string, confirmRecipientCount?: number) =>
    request<{ detail: string; dry_run: boolean; recipient_count: number; skipped: number }>(
      `${CAMPAIGNS}${id}/send/`, post({ confirm_recipient_count: confirmRecipientCount }), token
    ),
  retryFailed: (token: string, id: string, confirmRecipientCount?: number) =>
    request<{ detail: string; recipient_count: number }>(
      `${CAMPAIGNS}${id}/retry-failed/`, post({ confirm_recipient_count: confirmRecipientCount }), token
    ),
  resolveUnknown: (token: string, id: string, outcome: "sent" | "failed") =>
    request<{ detail: string; updated: number }>(`${CAMPAIGNS}${id}/resolve-unknown/`, post({ outcome }), token),
  refreshStatus: (token: string, id: string) =>
    request<{ detail: string }>(`${CAMPAIGNS}${id}/refresh-status/`, post(), token),
  recipients: (token: string, id: string, params = "") =>
    request<PaginatedResponse<CampaignRecipient> & { status_totals: Record<string, number> }>(
      `${CAMPAIGNS}${id}/recipients/?${params}`, {}, token
    ),
  audit: (token: string, id: string) => request<CampaignAuditEntry[]>(`${CAMPAIGNS}${id}/audit/`, {}, token),
  smsConfig: (token: string) => request<SmsConfig>("/communications/sms/config/", {}, token),
};

export const usersApi = {
  list: (token: string, params = "") =>
    request<PaginatedResponse<User>>(`/auth/users/?${params}`, {}, token),
  create: (token: string, data: Record<string, unknown>) =>
    request<User>("/auth/users/", { method: "POST", body: JSON.stringify(data) }, token),
  update: (token: string, id: number, data: Partial<User>) =>
    request<User>(`/auth/users/${id}/`, { method: "PATCH", body: JSON.stringify(data) }, token),
  remove: (token: string, id: number) =>
    request<void>(`/auth/users/${id}/`, { method: "DELETE" }, token),
};
