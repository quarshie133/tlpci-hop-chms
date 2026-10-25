/**
 * Display helpers shared across modules: labels for backend choice values,
 * money / date formatting, and initials.
 */

export const MEMBER_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  active: { label: "Active member", tone: "success" },
  visitor: { label: "Visitor", tone: "accent" },
  inactive: { label: "Inactive", tone: "neutral" },
  transferred: { label: "Transferred out", tone: "brand" },
  deceased: { label: "Deceased", tone: "neutral" },
};

export const LIFE_STAGES: Array<{ value: string; label: string }> = [
  { value: "infant", label: "Infant" },
  { value: "child", label: "Child" },
  { value: "teen", label: "Teen" },
  { value: "young_adult", label: "Young adult" },
  { value: "adult", label: "Adult" },
  { value: "senior", label: "Senior" },
];

export const MARITAL_STATUSES: Array<{ value: string; label: string }> = [
  { value: "single", label: "Single" },
  { value: "married", label: "Married" },
  { value: "divorced", label: "Divorced" },
  { value: "widowed", label: "Widowed" },
  { value: "separated", label: "Separated" },
];

export const GENDERS: Array<{ value: string; label: string }> = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "other", label: "Other" },
];

export const CONTRIBUTION_TYPES: Array<{ value: string; label: string }> = [
  { value: "tithe", label: "Tithe" },
  { value: "offering", label: "Offering" },
  { value: "donation", label: "Donation" },
  { value: "pledge_payment", label: "Pledge payment" },
  { value: "building", label: "Building fund" },
  { value: "missions", label: "Missions" },
  { value: "other", label: "Other" },
];

export const PAYMENT_METHODS: Array<{ value: string; label: string; icon: string }> = [
  { value: "cash", label: "Cash", icon: "payments" },
  { value: "check", label: "Check", icon: "receipt_long" },
  { value: "card", label: "Card", icon: "credit_card" },
  { value: "bank_transfer", label: "Bank transfer", icon: "account_balance" },
  { value: "online", label: "Online", icon: "language" },
  { value: "mobile_money", label: "Mobile money", icon: "smartphone" },
  { value: "other", label: "Other", icon: "more_horiz" },
];

export const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  church_admin: "Church Admin",
  pastor: "Pastor",
  staff: "Staff",
  volunteer: "Volunteer",
  member: "Member",
};

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger" | "accent";

export function labelFor(options: Array<{ value: string; label: string }>, value?: string | null): string {
  if (!value) return "—";
  return options.find((o) => o.value === value)?.label ?? humanize(value);
}

export function humanize(value?: string | null): string {
  if (!value) return "";
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function initials(first?: string | null, last?: string | null): string {
  return `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase() || "?";
}

export function initialsFromName(name?: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return initials(parts[0], parts.length > 1 ? parts[parts.length - 1] : "");
}

/** The church's currency: Ghana cedis. */
export const CHURCH_CURRENCY = "GHS";

/** Money in Ghanaian format, e.g. GH₵1,900.00. */
export function formatMoney(value: string | number | null | undefined, currency = CHURCH_CURRENCY): string {
  const n = typeof value === "string" ? parseFloat(value) : value ?? 0;
  if (Number.isNaN(n)) return "—";
  try {
    return new Intl.NumberFormat("en-GH", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}

/** Parse a YYYY-MM-DD date as a local calendar date (no timezone shift). */
export function parseDateOnly(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function formatDate(value?: string | null, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }): string {
  if (!value) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseDateOnly(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", opts);
}

export function formatTime(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  return `${formatDate(value)} · ${formatTime(value)}`;
}

/** "HH:MM:SS" → "7:00 PM" */
export function formatClock(value?: string | null): string {
  if (!value) return "";
  const [h, m] = value.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m || 0, 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function relativeTime(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value).getTime();
  if (Number.isNaN(d)) return "";
  const diff = Date.now() - d;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDate(value);
}

/** Today's date as YYYY-MM-DD in local time. */
export function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Convert an ISO datetime to the value format of <input type="datetime-local">. */
export function toLocalInput(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert a datetime-local input value (local time) to an ISO string in UTC. */
export function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
