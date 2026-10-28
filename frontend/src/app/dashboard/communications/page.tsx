"use client";

import { useCallback, useEffect, useMemo, useState, type SyntheticEvent } from "react";
import Link from "next/link";
import { useAuth, ADMIN_ROLES } from "@/lib/auth-context";
import {
  communicationsApi,
  errorMessage,
  fieldError,
  groupsApi,
  listAll,
  membersApi,
  type ApiError,
  type AudienceSpec,
  type Campaign,
  type CampaignRecipient,
} from "@/lib/api";
import { useAsync, useDebounced } from "@/lib/hooks";
import { formatDateTime, formatNumber, humanize, labelFor, LIFE_STAGES, relativeTime } from "@/lib/format";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { CampaignStatusBadge, RecipientStatusBadge } from "@/components/domain";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  SearchInput,
  Segmented,
  Skeleton,
  TableSkeleton,
} from "@/components/ui/primitives";

/* ── SMS length / segment calculation (mirrors the server) ───────────── */
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€";

function smsInfo(text: string) {
  let gsm = true;
  let units = 0;
  for (const ch of text) {
    if (GSM7.includes(ch)) units += 1;
    else if (GSM7_EXT.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (!gsm) {
    const len = Array.from(text).length;
    return { encoding: "Unicode", length: len, segments: len === 0 ? 0 : len <= 70 ? 1 : Math.ceil(len / 67), perSegment: len <= 70 ? 70 : 67 };
  }
  return { encoding: "Standard (GSM-7)", length: units, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153), perSegment: units <= 160 ? 160 : 153 };
}

/* ── Audiences (validated again on the server) ───────────────────────── */
type AudienceKind = "active" | "everyone" | "visitors" | "group" | "life_stage" | "members" | "phone";

const AUDIENCES: Array<{ value: AudienceKind; label: string; description: string; icon: string; smsOnly?: boolean }> = [
  { value: "active", label: "Active members", description: "Everyone with Active member status", icon: "verified" },
  { value: "everyone", label: "Whole directory", description: "Active members, visitors and inactive people", icon: "groups" },
  { value: "visitors", label: "Visitors", description: "People marked as visitors", icon: "waving_hand" },
  { value: "group", label: "A group or ministry", description: "Active members of one group", icon: "diversity_3" },
  { value: "life_stage", label: "A life stage", description: "Active members in one life stage", icon: "family_restroom" },
  { value: "members", label: "Selected people", description: "Pick individuals from the directory", icon: "how_to_reg" },
  { value: "phone", label: "One phone number", description: "Send to a single Ghana mobile number", icon: "dialpad", smsOnly: true },
];

/** Broadcasts that are done processing; admins may delete these from history. */
const FINISHED_STATUSES = ["sent", "partially_sent", "needs_review", "failed"];

const GH_PHONE = /^(?:\+?233|0)?[25]\d{8}$/;

const LARGE_FALLBACK = 25;
type View = "compose" | "history";

export default function CommunicationsPage() {
  const { token, hasRole } = useAuth();
  const toast = useToast();
  const t = token ?? "";
  const isAdmin = hasRole(...ADMIN_ROLES);

  const [view, setView] = useState<View>("compose");

  // Composer state
  const [draftId, setDraftId] = useState<string | null>(null);
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [senderId, setSenderId] = useState("");
  const [includeName, setIncludeName] = useState(true);
  const [audience, setAudience] = useState<AudienceKind>("active");
  const [chosenGroupId, setGroupId] = useState("");
  const [lifeStage, setLifeStage] = useState("adult");
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [pickerSearch, setPickerSearch] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneName, setPhoneName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<unknown>(null);
  const [savingDraft, setSavingDraft] = useState(false);

  // Reference data
  const config = useAsync(token ? () => communicationsApi.smsConfig(t) : null, [token]);
  const groups = useAsync(token ? () => listAll(groupsApi.list, t, "is_active=true") : null, [token]);
  const members = useAsync(token && audience === "members" ? () => listAll(membersApi.list, t, "ordering=last_name") : null, [token, audience === "members"]);
  const history = useAsync(token ? () => communicationsApi.list(t, "page_size=50") : null, [token]);

  const cfg = config.data;
  const groupId = chosenGroupId || groups.data?.[0]?.id || "";
  const effectiveSender = senderId || cfg?.default_sender_id || "";
  const threshold = cfg?.large_broadcast_threshold ?? LARGE_FALLBACK;

  /** Typed audience spec, or null while the selection is incomplete. */
  const spec: AudienceSpec | null = useMemo(() => {
    switch (audience) {
      case "group":
        return groupId ? { type: "group", group_id: groupId } : null;
      case "life_stage":
        return { type: "life_stage", life_stage: lifeStage };
      case "members":
        return pickedIds.length ? { type: "members", member_ids: [...pickedIds].sort() } : null;
      case "phone":
        return GH_PHONE.test(phone.replace(/[\s\-().]/g, "")) ? { type: "phone", phone: phone.trim(), name: phoneName.trim() } : null;
      default:
        return { type: audience };
    }
  }, [audience, groupId, lifeStage, pickedIds, phone, phoneName]);

  // Server-side recipient preview (authoritative count of who will receive it).
  const specKey = JSON.stringify(spec);
  const debouncedSpecKey = useDebounced(specKey, 350);
  const debouncedBody = useDebounced(body, 500);
  const debouncedName = useDebounced(name, 500);
  const preview = useAsync(
    token && debouncedSpecKey !== "null"
      ? () =>
          communicationsApi.preview(t, {
            channel,
            recipients_filter: JSON.parse(debouncedSpecKey),
            body: debouncedBody,
            name: debouncedName,
            include_name_in_sms: includeName,
          })
      : null,
    [token, channel, debouncedSpecKey, debouncedBody, debouncedName, includeName]
  );
  const previewStale = specKey !== debouncedSpecKey;
  const recipientsLoading = (preview.loading || previewStale) && spec !== null;
  const reachable = spec && !previewStale ? preview.data?.recipients ?? 0 : 0;

  // Poll history while any broadcast is queued or sending, so statuses update on their own.
  const processing = (history.data?.results ?? []).some((c) => c.status === "scheduled" || c.status === "sending");
  const reloadHistory = history.reload;
  useEffect(() => {
    if (!processing) return;
    const id = window.setInterval(reloadHistory, 6000);
    return () => window.clearInterval(id);
  }, [processing, reloadHistory]);

  // SMS has no subject field, so the broadcast name can be sent as the first line (matches the backend's compose_sms).
  const smsText = channel === "sms" && includeName && name.trim() ? `${name.trim()}\n${body}` : body;
  const sms = smsInfo(smsText);
  const audienceLabel =
    audience === "group"
      ? `Group: ${groups.data?.find((g) => g.id === groupId)?.name ?? "—"}`
      : audience === "life_stage"
        ? `Life stage: ${labelFor(LIFE_STAGES, lifeStage)}`
        : audience === "members"
          ? `${pickedIds.length} selected ${pickedIds.length === 1 ? "person" : "people"}`
          : audience === "phone"
            ? phoneName.trim() || phone
            : AUDIENCES.find((a) => a.value === audience)!.label;

  const smsBlocked = channel === "sms" && cfg !== null && cfg !== undefined && !cfg.dry_run && !cfg.configured;

  const validate = () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Give this broadcast a name so you can find it later.";
    if (channel === "email" && !subject.trim()) e.subject = "Email broadcasts need a subject line.";
    if (!body.trim()) e.body = "Write the message you want to send.";
    if (cfg && channel === "sms" && smsText.length > cfg.max_message_length)
      e.body = `SMS messages are limited to ${cfg.max_message_length} characters${includeName ? ", including the title line" : ""}.`;
    if (audience === "group" && !groupId) e.audience = "Choose a group.";
    if (audience === "members" && pickedIds.length === 0) e.audience = "Select at least one person.";
    if (audience === "phone" && !spec) e.phone = "Enter a Ghana mobile number, e.g. 0241234567 or +233241234567.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const payload = () => ({
    name: name.trim(),
    channel,
    subject: channel === "email" ? subject.trim() : "",
    body: body.trim(),
    sender_id: channel === "sms" ? effectiveSender : "",
    include_name_in_sms: channel === "sms" && includeName,
    recipients_filter: spec as AudienceSpec,
  });

  /** Create or update the draft campaign; returns its id. */
  const persistDraft = async (): Promise<string> => {
    if (draftId) {
      const updated = await communicationsApi.update(t, draftId, payload());
      return updated.id;
    }
    const created = await communicationsApi.create(t, payload());
    setDraftId(created.id);
    return created.id;
  };

  const resetComposer = () => {
    setDraftId(null);
    setName("");
    setIncludeName(true);
    setSubject("");
    setBody("");
    setPickedIds([]);
    setPhone("");
    setPhoneName("");
    setErrors({});
    setApiError(null);
  };

  const saveDraft = async () => {
    if (!token || savingDraft || !validate()) return;
    setSavingDraft(true);
    setApiError(null);
    try {
      await persistDraft();
      toast.success("Draft saved", "Find it any time under History.");
      history.reload();
    } catch (err) {
      setApiError(err);
    } finally {
      setSavingDraft(false);
    }
  };

  // ── Send confirmation ──────────────────────────────────────────────────
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirmNote, setConfirmNote] = useState("");

  const openConfirm = (e?: SyntheticEvent) => {
    e?.preventDefault();
    if (!validate()) return;
    setAck(false);
    setConfirmNote("");
    setConfirmOpen(true);
  };

  const large = reachable >= threshold;

  const send = async () => {
    if (!token || sending) return;
    setSending(true);
    try {
      const id = await persistDraft();
      const res = await communicationsApi.send(t, id, reachable);
      if (res.dry_run) {
        toast.info("Test broadcast queued", `Test mode is on: ${formatNumber(res.recipient_count)} messages will be recorded as simulated. Nothing is sent.`);
      } else {
        toast.info("Broadcast queued", `${formatNumber(res.recipient_count)} messages are being handed to AgooSMS. Check History for results.`);
      }
      setConfirmOpen(false);
      resetComposer();
      history.reload();
      setView("history");
    } catch (err) {
      const e = err as ApiError;
      if (e.code === "confirmation_required" && typeof e.body?.recipient_count === "number") {
        setConfirmNote(`The audience changed since the preview — it now has ${formatNumber(e.body.recipient_count as number)} recipients. Review and confirm again.`);
        setAck(false);
        preview.reload();
      } else if (e.code === "already_sent") {
        setConfirmOpen(false);
        resetComposer();
        toast.warning("Already sent", "This broadcast was already queued. Check History for its status.");
        history.reload();
        setView("history");
      } else {
        setConfirmOpen(false);
        setApiError(err);
        toast.error("Broadcast not sent", errorMessage(err));
      }
    } finally {
      setSending(false);
    }
  };

  // ── History actions ────────────────────────────────────────────────────
  const [toDelete, setToDelete] = useState<Campaign | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [viewing, setViewing] = useState<Campaign | null>(null);

  const openDraft = (c: Campaign) => {
    const f = (c.recipients_filter ?? {}) as Record<string, unknown>;
    setDraftId(c.id);
    setChannel(c.channel === "email" ? "email" : "sms");
    setName(c.name);
    setSubject(c.subject ?? "");
    setBody(c.body ?? "");
    setSenderId(c.sender_id ?? "");
    setIncludeName(c.include_name_in_sms ?? false);
    const type = String(f.type ?? "");
    if (type === "group") {
      setAudience("group");
      setGroupId(String(f.group_id ?? ""));
    } else if (type === "life_stage") {
      setAudience("life_stage");
      setLifeStage(String(f.life_stage ?? "adult"));
    } else if (type === "members") {
      setAudience("members");
      setPickedIds(Array.isArray(f.member_ids) ? (f.member_ids as string[]) : []);
    } else if (type === "phone") {
      setAudience("phone");
      setPhone(String(f.phone ?? ""));
      setPhoneName(String(f.name ?? ""));
    } else if (type === "visitors" || type === "everyone" || type === "active") {
      setAudience(type);
    } else {
      setAudience("active");
    }
    setErrors({});
    setApiError(null);
    setView("compose");
  };

  const confirmDeleteCampaign = async () => {
    if (!toDelete || deleting) return;
    setDeleting(true);
    try {
      await communicationsApi.remove(t, toDelete.id);
      if (draftId === toDelete.id) resetComposer();
      if (viewing?.id === toDelete.id) setViewing(null);
      toast.success(toDelete.status === "draft" ? "Draft deleted" : "Broadcast deleted", `“${toDelete.name}” was removed from history.`);
      setToDelete(null);
      history.reload();
    } catch (err) {
      toast.error("Couldn't delete", errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const campaigns = history.data?.results ?? [];
  const availableAudiences = AUDIENCES.filter((a) => !(a.smsOnly && channel !== "sms"));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Communication"
        description="Send SMS and email broadcasts to members, visitors and groups."
        actions={
          <Segmented<View>
            label="Communication views"
            value={view}
            onChange={setView}
            options={[
              { value: "compose", label: "Compose", icon: "edit_square" },
              { value: "history", label: "History", icon: "history", count: history.data?.count },
            ]}
          />
        }
      />

      {cfg && channel === "sms" && cfg.dry_run && (
        <Alert tone="info" title="SMS test mode is on">
          Broadcasts are processed and recorded as <strong>simulated</strong>, but no real text messages are sent and no credit is used.
          {isAdmin && " To send real messages, configure AgooSMS and set SMS_DRY_RUN=False on the server."}
        </Alert>
      )}
      {smsBlocked && (
        <Alert tone="warning" title="SMS sending isn't set up yet">
          {cfg && !cfg.api_key_configured ? "The AgooSMS API key is missing." : "No approved AgooSMS sender ID is configured."} You can still write and save drafts.
          {isAdmin ? " See docs/SMS_AGOOSMS.md for the setup steps." : " Ask a church administrator to finish the SMS setup."}
        </Alert>
      )}

      {view === "compose" ? (
        <form onSubmit={openConfirm} noValidate className="grid grid-cols-1 gap-6 xl:grid-cols-12 xl:items-start">
          {/* ── Composer ─────────────────────────────────────────────── */}
          <Card className="xl:col-span-7">
            <CardHeader
              title={draftId ? "Edit draft" : "New broadcast"}
              icon="edit_square"
              actions={
                draftId ? (
                  <Button variant="ghost" size="sm" icon="add" onClick={resetComposer}>
                    Start new
                  </Button>
                ) : undefined
              }
            />
            <div className="flex flex-col gap-5 px-5 pb-5">
              {apiError ? <Alert title="Something went wrong">{errorMessage(apiError)}</Alert> : null}

              <div>
                <span className="field-label" id="channel-label">
                  Channel
                </span>
                <div role="radiogroup" aria-labelledby="channel-label" className="grid grid-cols-2 gap-2">
                  {(
                    [
                      { value: "sms", label: "SMS", icon: "sms", hint: "Text message via AgooSMS" },
                      { value: "email", label: "Email", icon: "mail", hint: "Email to saved addresses" },
                    ] as const
                  ).map((c) => {
                    const on = channel === c.value;
                    return (
                      <button
                        key={c.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => {
                          setChannel(c.value);
                          if (c.value === "email" && audience === "phone") setAudience("active");
                        }}
                        className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                          on ? "border-brand bg-brand-softer ring-1 ring-brand" : "border-line hover:border-line-strong"
                        }`}
                      >
                        <Icon name={c.icon} className={on ? "text-brand" : "text-ink-muted"} />
                        <span>
                          <span className="block text-sm font-semibold text-ink">{c.label}</span>
                          <span className="block text-[12px] text-ink-muted">{c.hint}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
                <Field label="Broadcast name" required hint={channel === "sms" && includeName ? "Sent as the first line of the text, like a title." : "Internal name — recipients don't see this."} error={errors.name || fieldError(apiError, "name")}>
                  {(p) => <Input {...p} value={name} maxLength={300} placeholder="e.g. Midweek service reminder" onChange={(e) => setName(e.target.value)} />}
                </Field>
                {channel === "sms" && (
                  <Field label="Sender ID" hint="Shown as the sender on phones" error={fieldError(apiError, "sender_id")}>
                    {(p) => (
                      <Select {...p} value={effectiveSender} disabled={!cfg || cfg.sender_ids.length === 0} onChange={(e) => setSenderId(e.target.value)}>
                        {!cfg || cfg.sender_ids.length === 0 ? (
                          <option value="">Not configured</option>
                        ) : (
                          cfg.sender_ids.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))
                        )}
                      </Select>
                    )}
                  </Field>
                )}
              </div>

              {channel === "sms" && (
                <Checkbox
                  checked={includeName}
                  onChange={setIncludeName}
                  label="Show the broadcast name as a title"
                  description="SMS has no subject line, so the name is added as the first line of the message. It counts toward the character limit."
                />
              )}

              {channel === "email" && (
                <Field label="Subject" required error={errors.subject || fieldError(apiError, "subject")}>
                  {(p) => <Input {...p} value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} />}
                </Field>
              )}

              <Field
                label="Message"
                required
                error={errors.body || fieldError(apiError, "body")}
                hint={channel === "sms" ? "The message is sent exactly as written to every recipient." : "Plain text. The message is sent exactly as written."}
              >
                {(p) => (
                  <Textarea
                    {...p}
                    rows={channel === "sms" ? 6 : 10}
                    value={body}
                    placeholder={channel === "sms" ? "Write your text message…" : "Write your email…"}
                    onChange={(e) => setBody(e.target.value)}
                  />
                )}
              </Field>

              {channel === "sms" && (
                <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-muted" aria-live="polite">
                  <span>
                    <span className="font-medium tabular-nums text-ink">{sms.length}</span> characters
                    {cfg ? ` (max ${cfg.max_message_length})` : ""}
                  </span>
                  <span>
                    <span className="font-medium tabular-nums text-ink">{sms.segments}</span> segment{sms.segments === 1 ? "" : "s"} per message (up to {sms.perSegment}{" "}
                    characters each)
                  </span>
                  <span>{sms.encoding}</span>
                  {sms.encoding === "Unicode" && body && <span className="text-warning">Emoji or special characters reduce the length of each segment.</span>}
                </div>
              )}
            </div>
          </Card>

          {/* ── Audience, summary & preview ─────────────────────────── */}
          <div className="flex flex-col gap-6 xl:col-span-5">
            <Card>
              <CardHeader title="Recipients" icon="group" />
              <div className="flex flex-col gap-4 px-5 pb-5">
                <div role="radiogroup" aria-label="Audience" className="flex flex-col gap-2">
                  {availableAudiences.map((a) => {
                    const on = audience === a.value;
                    return (
                      <button
                        key={a.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => {
                          setAudience(a.value);
                          setErrors((e) => ({ ...e, audience: "", phone: "" }));
                        }}
                        className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                          on ? "border-brand bg-brand-softer ring-1 ring-brand" : "border-line hover:border-line-strong"
                        }`}
                      >
                        <Icon name={a.icon} size={18} className={on ? "text-brand" : "text-ink-muted"} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-ink">{a.label}</span>
                          <span className="block text-[12px] text-ink-muted">{a.description}</span>
                        </span>
                        <span
                          aria-hidden
                          className={`h-4 w-4 flex-shrink-0 rounded-full border-2 ${on ? "border-brand bg-brand shadow-[inset_0_0_0_2px_#fff]" : "border-line-strong"}`}
                        />
                      </button>
                    );
                  })}
                </div>

                {audience === "group" && (
                  <Field label="Group" error={errors.audience}>
                    {(p) => (
                      <Select {...p} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                        {(groups.data ?? []).length === 0 && <option value="">No active groups</option>}
                        {(groups.data ?? []).map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name} ({g.member_count})
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                {audience === "life_stage" && (
                  <Field label="Life stage">
                    {(p) => (
                      <Select {...p} value={lifeStage} onChange={(e) => setLifeStage(e.target.value)}>
                        {LIFE_STAGES.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                {audience === "members" && (
                  <MemberPicker
                    loading={members.loading}
                    error={members.error}
                    members={members.data ?? []}
                    picked={pickedIds}
                    onChange={(ids) => {
                      setPickedIds(ids);
                      setErrors((e) => ({ ...e, audience: "" }));
                    }}
                    search={pickerSearch}
                    onSearch={setPickerSearch}
                    error2={errors.audience}
                  />
                )}
                {audience === "phone" && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Mobile number" required hint="Ghana numbers, e.g. 0241234567" error={errors.phone || (preview.error && !previewStale ? preview.error : undefined)}>
                      {(p) => (
                        <Input
                          {...p}
                          type="tel"
                          inputMode="tel"
                          value={phone}
                          placeholder="+233 24 123 4567"
                          onChange={(e) => {
                            setPhone(e.target.value);
                            setErrors((x) => ({ ...x, phone: "" }));
                          }}
                        />
                      )}
                    </Field>
                    <Field label="Name" hint="Optional, for the history">
                      {(p) => <Input {...p} value={phoneName} maxLength={200} onChange={(e) => setPhoneName(e.target.value)} />}
                    </Field>
                  </div>
                )}

                <div className="rounded-lg border border-line bg-surface-muted p-4" aria-live="polite">
                  {spec === null ? (
                    <p className="text-[13px] text-ink-muted">
                      {audience === "members" ? "Select people to see the recipient count." : audience === "phone" ? "Enter a valid number to continue." : "Choose an audience."}
                    </p>
                  ) : recipientsLoading && !preview.data ? (
                    <div className="space-y-2">
                      <Skeleton className="h-7 w-24" />
                      <Skeleton className="h-3.5 w-48" />
                    </div>
                  ) : preview.error && !previewStale ? (
                    <p className="text-[13px] text-danger">Couldn&apos;t calculate recipients: {preview.error}</p>
                  ) : preview.data ? (
                    <div className={recipientsLoading ? "opacity-60" : ""}>
                      <p className="text-[13px] text-ink-muted">Will be sent to</p>
                      <p className="text-2xl font-semibold tabular-nums text-ink">
                        {formatNumber(preview.data.recipients)}{" "}
                        <span className="text-base font-medium text-ink-muted">recipient{preview.data.recipients === 1 ? "" : "s"}</span>
                      </p>
                      <ul className="mt-1 space-y-0.5 text-[13px] text-ink-muted">
                        <li>{formatNumber(preview.data.matched)} match this audience</li>
                        {preview.data.missing_contact > 0 && (
                          <li>
                            {formatNumber(preview.data.missing_contact)} skipped — no {channel === "sms" ? "mobile number" : "email address"} on file
                          </li>
                        )}
                        {preview.data.invalid > 0 && (
                          <li className="text-warning">
                            {formatNumber(preview.data.invalid)} skipped — invalid {channel === "sms" ? "Ghana mobile number" : "email"}
                            {preview.data.invalid_sample.length > 0 && (
                              <>
                                {": "}
                                {preview.data.invalid_sample.slice(0, 3).map((p, i) => (
                                  <span key={p.member_id ?? i}>
                                    {i > 0 && ", "}
                                    {p.member_id ? (
                                      <Link className="underline" href={`/dashboard/members/${p.member_id}`}>
                                        {p.name}
                                      </Link>
                                    ) : (
                                      p.name
                                    )}
                                  </span>
                                ))}
                                {preview.data.invalid > 3 && " …"}
                              </>
                            )}
                          </li>
                        )}
                        {preview.data.duplicates_removed > 0 && <li>{formatNumber(preview.data.duplicates_removed)} duplicate number{preview.data.duplicates_removed === 1 ? "" : "s"} sent once</li>}
                        {channel === "sms" && preview.data.recipients * sms.segments > 0 ? (
                          <li>Estimated {formatNumber(preview.data.recipients * sms.segments)} SMS segments in total</li>
                        ) : null}
                      </ul>
                    </div>
                  ) : null}
                </div>
                {large && !recipientsLoading && (
                  <Alert tone="warning" title="Large broadcast">
                    This message will go to {formatNumber(reachable)} people. You&apos;ll be asked to confirm before it&apos;s sent.
                  </Alert>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Preview" icon="visibility" />
              <div className="px-5 pb-5">
                {channel === "sms" ? (
                  <div className="mx-auto max-w-xs rounded-[1.75rem] border border-line bg-surface-muted p-4">
                    <p className="mb-3 text-center text-[11px] font-medium text-ink-subtle">From {effectiveSender || "your sender ID"}</p>
                    {body.trim() ? (
                      <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand px-3.5 py-2.5 text-[13px] leading-relaxed text-white">
                        {smsText}
                      </div>
                    ) : (
                      <p className="py-6 text-center text-[13px] text-ink-subtle">Your message will appear here.</p>
                    )}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-line">
                    <div className="border-b border-line bg-surface-muted px-4 py-2.5">
                      <p className="text-[12px] text-ink-muted">Subject</p>
                      <p className="truncate text-sm font-semibold text-ink">{subject || "No subject yet"}</p>
                    </div>
                    <p className="min-h-24 whitespace-pre-wrap break-words px-4 py-3 text-[13px] leading-relaxed text-ink">
                      {body || <span className="text-ink-subtle">Your message will appear here.</span>}
                    </p>
                  </div>
                )}
              </div>
            </Card>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button icon="save" onClick={saveDraft} loading={savingDraft}>
                {draftId ? "Update draft" : "Save draft"}
              </Button>
              <Button type="submit" variant="primary" icon="send" disabled={recipientsLoading || reachable === 0 || smsBlocked}>
                Review & send
              </Button>
            </div>
            {!recipientsLoading && spec !== null && preview.data && reachable === 0 && (
              <p className="text-right text-[13px] text-ink-muted">
                No one in this audience has {channel === "sms" ? "a valid mobile number" : "an email address"} on file.
              </p>
            )}
          </div>
        </form>
      ) : (
        <Card className="overflow-hidden">
          <CardHeader
            title="Broadcast history"
            description={
              processing
                ? "Updating automatically while broadcasts are processing…"
                : "“Accepted” means the provider took the message; it doesn't confirm delivery to the phone."
            }
            icon="history"
            actions={
              <Button size="sm" icon="refresh" onClick={history.reload} loading={history.loading && Boolean(history.data)}>
                Refresh
              </Button>
            }
          />
          {history.loading && !history.data ? (
            <TableSkeleton rows={4} cols={4} />
          ) : history.error ? (
            <ErrorState message={history.error} onRetry={history.reload} />
          ) : campaigns.length === 0 ? (
            <EmptyState
              icon="campaign"
              title="No broadcasts yet"
              description="Drafts and sent broadcasts will be listed here."
              action={
                <Button variant="primary" icon="edit_square" onClick={() => setView("compose")}>
                  Compose a broadcast
                </Button>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Broadcast</th>
                    <th scope="col">Audience</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">
                      Recipients
                    </th>
                    <th scope="col" className="num">
                      Accepted
                    </th>
                    <th scope="col" className="num">
                      Failed
                    </th>
                    <th scope="col" className="num">
                      Unclear
                    </th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => {
                    const draft = c.status === "draft";
                    return (
                      <tr key={c.id}>
                        <td>
                          <div className="flex items-center gap-3">
                            <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                              <Icon name={c.channel === "email" ? "mail" : "sms"} size={18} />
                            </span>
                            <div className="min-w-0">
                              <button type="button" onClick={() => setViewing(c)} className="block max-w-[240px] truncate text-left font-medium text-ink hover:text-brand hover:underline">
                                {c.name}
                              </button>
                              <span className="block text-[13px] text-ink-muted" title={formatDateTime(c.completed_at || c.created_at)}>
                                {c.completed_at ? `Finished ${relativeTime(c.completed_at)}` : `Created ${relativeTime(c.created_at)}`}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap text-ink-muted">{c.audience_label || "—"}</td>
                        <td>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <CampaignStatusBadge status={c.status} />
                            {c.dry_run && <Badge tone="neutral">Test</Badge>}
                          </div>
                        </td>
                        <td className="num">{draft ? "—" : formatNumber(c.recipient_count)}</td>
                        <td className="num">{draft ? "—" : formatNumber(c.sent_count)}</td>
                        <td className={`num ${c.failed_count ? "font-semibold text-danger" : ""}`}>{draft ? "—" : formatNumber(c.failed_count ?? 0)}</td>
                        <td className={`num ${c.unknown_count ? "font-semibold text-accent-ink" : ""}`}>{draft ? "—" : formatNumber(c.unknown_count ?? 0)}</td>
                        <td>
                          <div className="flex items-center justify-end gap-1">
                            {draft ? (
                              <>
                                <Button size="xs" icon="edit" onClick={() => openDraft(c)}>
                                  Edit
                                </Button>
                                <Button variant="danger-ghost" size="xs" iconOnly icon="delete" aria-label={`Delete ${c.name}`} title="Delete draft" onClick={() => setToDelete(c)} />
                              </>
                            ) : (
                              <>
                                <Button size="xs" icon="visibility" onClick={() => setViewing(c)}>
                                  Details
                                </Button>
                                {isAdmin && FINISHED_STATUSES.includes(c.status) && (
                                  <Button variant="danger-ghost" size="xs" iconOnly icon="delete" aria-label={`Delete ${c.name}`} title="Delete from history" onClick={() => setToDelete(c)} />
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ── Send confirmation ─────────────────────────────────────────── */}
      <Modal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={cfg?.dry_run && channel === "sms" ? "Run this test broadcast?" : "Send this broadcast?"}
        subtitle={cfg?.dry_run && channel === "sms" ? "Test mode is on — nothing will actually be sent." : "Review the details below. Messages can't be recalled once sent."}
        maxWidth="lg"
        isSubmitting={sending}
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)} disabled={sending}>
              Keep editing
            </Button>
            <Button variant="primary" icon="send" onClick={send} loading={sending} disabled={(large && !ack) || reachable === 0 || recipientsLoading}>
              {sending ? "Queuing…" : `Send to ${formatNumber(reachable)} ${reachable === 1 ? "person" : "people"}`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {confirmNote && <Alert tone="warning">{confirmNote}</Alert>}
          <dl className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-surface-muted p-4 text-sm">
            <div>
              <dt className="text-[12px] text-ink-muted">Channel</dt>
              <dd className="font-medium text-ink">{channel === "sms" ? `SMS · ${effectiveSender || "no sender ID"}` : "Email"}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-muted">Audience</dt>
              <dd className="truncate font-medium text-ink">{audienceLabel}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-muted">Recipients</dt>
              <dd className="font-medium tabular-nums text-ink">
                {formatNumber(reachable)}
                {preview.data && preview.data.invalid + preview.data.missing_contact > 0 && (
                  <span className="font-normal text-ink-muted"> ({formatNumber(preview.data.invalid + preview.data.missing_contact)} skipped)</span>
                )}
              </dd>
            </div>
            {channel === "sms" ? (
              <div>
                <dt className="text-[12px] text-ink-muted">Estimated segments</dt>
                <dd className="font-medium tabular-nums text-ink">{formatNumber(reachable * sms.segments)}</dd>
              </div>
            ) : (
              <div>
                <dt className="text-[12px] text-ink-muted">Subject</dt>
                <dd className="truncate font-medium text-ink">{subject}</dd>
              </div>
            )}
          </dl>
          <div>
            <p className="mb-1.5 text-[12px] font-medium text-ink-muted">Message</p>
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line p-3 text-[13px] leading-relaxed text-ink">{smsText}</p>
          </div>
          <p className="text-[13px] text-ink-muted">
            The broadcast is queued and processed in the background{channel === "sms" ? " by AgooSMS" : ""}. History shows how many messages the
            provider accepted, rejected, or that need review.
          </p>
          {large && (
            <div className="rounded-lg border border-warning-line bg-warning-soft p-3">
              <Checkbox checked={ack} onChange={setAck} label={`I confirm this should be sent to ${formatNumber(reachable)} people`} />
            </div>
          )}
        </div>
      </Modal>

      <CampaignDrawer
        key={viewing?.id ?? "closed"}
        campaign={viewing}
        token={t}
        isAdmin={isAdmin}
        onClose={() => setViewing(null)}
        onChanged={history.reload}
        onDelete={(c) => setToDelete(c)}
      />

      <ConfirmDialog
        isOpen={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={confirmDeleteCampaign}
        title={toDelete?.status === "draft" ? "Delete draft?" : "Delete broadcast from history?"}
        message={
          toDelete?.status === "draft" ? (
            <>
              <strong className="font-semibold text-ink">{toDelete?.name}</strong> will be permanently deleted.
            </>
          ) : (
            <>
              <strong className="font-semibold text-ink">{toDelete?.name}</strong> and its record of who it was sent to, delivery results and activity
              log will be permanently deleted.
              {toDelete && toDelete.sent_count > 0
                ? ` ${formatNumber(toDelete.sent_count)} message(s) were already accepted by the provider — deleting the record doesn't recall them.`
                : " No messages from this broadcast were sent."}
            </>
          )
        }
        confirmText={toDelete?.status === "draft" ? "Delete draft" : "Delete broadcast"}
        isLoading={deleting}
      />
    </div>
  );
}

/* ── Member picker for the "Selected people" audience ────────────────── */
function MemberPicker({
  loading,
  error,
  members,
  picked,
  onChange,
  search,
  onSearch,
  error2,
}: {
  loading: boolean;
  error: string | null;
  members: Array<{ id: string; full_name: string; phone_mobile: string; email: string }>;
  picked: string[];
  onChange: (ids: string[]) => void;
  search: string;
  onSearch: (v: string) => void;
  error2?: string;
}) {
  const q = search.trim().toLowerCase();
  const visible = members.filter((m) => !q || m.full_name.toLowerCase().includes(q) || m.phone_mobile.includes(q)).slice(0, 200);
  const set = new Set(picked);
  const toggle = (id: string) => onChange(set.has(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="field-label mb-0">People</span>
        <span className="text-[12px] text-ink-muted">
          {picked.length} selected
          {picked.length > 0 && (
            <button type="button" className="ml-2 font-medium text-brand hover:underline" onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </span>
      </div>
      <SearchInput value={search} onChange={onSearch} placeholder="Search name or phone" label="Search people to message" />
      <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-line" role="group" aria-label="People to message">
        {loading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : error ? (
          <p className="p-3 text-[13px] text-danger">{error}</p>
        ) : visible.length === 0 ? (
          <p className="p-3 text-[13px] text-ink-muted">No matching people.</p>
        ) : (
          <ul className="divide-y divide-line">
            {visible.map((m) => (
              <li key={m.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-canvas">
                  <input type="checkbox" checked={set.has(m.id)} onChange={() => toggle(m.id)} className="h-4 w-4 accent-[var(--color-brand)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{m.full_name}</span>
                    <span className="block truncate text-[12px] text-ink-muted">{m.phone_mobile || "No mobile number"}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error2 && <p className="mt-1.5 text-[12px] text-danger">{error2}</p>}
    </div>
  );
}

/* ── Broadcast details: per-recipient results, audit trail, recovery actions ── */
type RecipientFilter = "all" | "accepted" | "failed" | "unknown" | "skipped";

/** Each filter maps to individual recipient statuses (sent as repeated recipient_status params). */
const RECIPIENT_FILTER_STATUSES: Record<RecipientFilter, string[]> = {
  all: [],
  accepted: ["sent", "delivered", "simulated"],
  failed: ["failed", "bounced"],
  unknown: ["unknown"],
  skipped: ["skipped"],
};

const AUDIT_LABELS: Record<string, string> = {
  created: "Draft created",
  updated: "Draft edited",
  queued: "Queued for sending",
  queue_failed: "Could not queue — nothing sent",
  processing: "Processing started",
  completed: "Processing finished",
  retry_requested: "Retry of failed messages requested",
  resolved: "Unclear outcomes reviewed",
  status_refresh: "Delivery status checked",
};

function CampaignDrawer({
  campaign,
  token,
  isAdmin,
  onClose,
  onChanged,
  onDelete,
}: {
  campaign: Campaign | null;
  token: string;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
  onDelete: (c: Campaign) => void;
}) {
  const toast = useToast();
  const [current, setCurrent] = useState<Campaign | null>(campaign);
  const [filter, setFilter] = useState<RecipientFilter>("all");
  const [rows, setRows] = useState<CampaignRecipient[] | null>(null);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [audit, setAudit] = useState<Array<{ id: number; action: string; created_at: string; detail: Record<string, unknown> }> | null>(null);

  const [retryCount, setRetryCount] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const id = campaign?.id;

  const fetchPage = useCallback(
    (page: number, status: RecipientFilter) => {
      if (!id) return Promise.resolve();
      const qs = new URLSearchParams({ page: String(page), page_size: "50" });
      for (const s of RECIPIENT_FILTER_STATUSES[status]) qs.append("recipient_status", s);
      return communicationsApi.recipients(token, id, qs.toString()).then((res) => {
        setRows((prev) => (page === 1 ? res.results : [...(prev ?? []), ...res.results]));
        setTotals(res.status_totals);
        setNextPage(res.next ? page + 1 : null);
      });
    },
    [id, token]
  );

  const reloadAll = useCallback(() => {
    if (!id) return;
    communicationsApi.get(token, id).then(setCurrent).catch(() => undefined);
    fetchPage(1, filter).catch((e) => setLoadError(errorMessage(e)));
    communicationsApi.audit(token, id).then(setAudit).catch(() => setAudit([]));
  }, [id, token, fetchPage, filter]);

  useEffect(() => {
    if (!id) return;
    communicationsApi.get(token, id).then(setCurrent).catch(() => undefined);
    communicationsApi.audit(token, id).then(setAudit).catch(() => setAudit([]));
  }, [id, token]);

  useEffect(() => {
    if (!id) return;
    fetchPage(1, filter).catch((e) => setLoadError(errorMessage(e)));
  }, [id, filter, fetchPage]);

  // Keep the drawer live while the broadcast is processing.
  const live = current?.status === "scheduled" || current?.status === "sending";
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      reloadAll();
      onChanged();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [live, reloadAll, onChanged]);

  const loadMore = () => {
    if (nextPage === null || loadingMore) return;
    setLoadingMore(true);
    fetchPage(nextPage, filter)
      .catch((e) => toast.error("Couldn't load more recipients", errorMessage(e)))
      .finally(() => setLoadingMore(false));
  };

  const askRetry = async () => {
    if (!id) return;
    try {
      await communicationsApi.retryFailed(token, id);
    } catch (err) {
      const e = err as ApiError;
      if (e.code === "confirmation_required" && typeof e.body?.recipient_count === "number") {
        setRetryCount(e.body.recipient_count as number);
        return;
      }
      toast.error("Can't retry", errorMessage(err));
    }
  };

  const confirmRetry = async () => {
    if (!id || retryCount === null || retrying) return;
    setRetrying(true);
    try {
      const res = await communicationsApi.retryFailed(token, id, retryCount);
      toast.info("Retry queued", `${formatNumber(res.recipient_count)} failed message(s) will be sent again.`);
      setRetryCount(null);
      reloadAll();
      onChanged();
    } catch (err) {
      toast.error("Retry not queued", errorMessage(err));
    } finally {
      setRetrying(false);
    }
  };

  const resolve = async (outcome: "sent" | "failed") => {
    if (!id || resolving) return;
    setResolving(true);
    try {
      const res = await communicationsApi.resolveUnknown(token, id, outcome);
      toast.success("Review saved", res.detail);
      setResolveOpen(false);
      reloadAll();
      onChanged();
    } catch (err) {
      toast.error("Couldn't save review", errorMessage(err));
    } finally {
      setResolving(false);
    }
  };

  const refreshDelivery = async () => {
    if (!id || refreshing) return;
    setRefreshing(true);
    try {
      await communicationsApi.refreshStatus(token, id);
      toast.info("Checking delivery status", "Results will appear here in a moment.");
      window.setTimeout(reloadAll, 4000);
    } catch (err) {
      toast.error("Couldn't check delivery status", errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  };

  const c = current;
  const finished = c && FINISHED_STATUSES.includes(c.status);
  const failed = totals.failed ?? 0;
  const unknown = totals.unknown ?? 0;

  return (
    <>
      <Modal
        isOpen={Boolean(campaign)}
        onClose={onClose}
        title={c?.name ?? "Broadcast"}
        subtitle={c ? `${c.channel.toUpperCase()}${c.sender_id ? ` · ${c.sender_id}` : ""} · ${c.audience_label ?? ""}` : undefined}
        variant="drawer"
        maxWidth="sm:max-w-xl"
      >
        {c && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <CampaignStatusBadge status={c.status} />
              {c.dry_run && <Badge tone="neutral">Test mode — nothing sent</Badge>}
              {live && <span className="text-[12px] text-ink-muted">Updating…</span>}
            </div>

            {c.status !== "draft" && (
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: c.dry_run ? "Simulated" : "Accepted", value: c.sent_count, cls: "text-ink" },
                  { label: "Failed", value: c.failed_count ?? 0, cls: (c.failed_count ?? 0) ? "text-danger" : "text-ink" },
                  { label: "Unclear", value: c.unknown_count ?? 0, cls: (c.unknown_count ?? 0) ? "text-accent-ink" : "text-ink" },
                  { label: "Skipped", value: c.skipped_count ?? 0, cls: "text-ink" },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border border-line p-3">
                    <dt className="text-[12px] text-ink-muted">{s.label}</dt>
                    <dd className={`text-xl font-semibold tabular-nums ${s.cls}`}>{formatNumber(s.value)}</dd>
                  </div>
                ))}
              </dl>
            )}

            {c.last_error && <Alert tone="warning">{c.last_error}</Alert>}
            {unknown > 0 && (
              <Alert tone="warning" title={`${formatNumber(unknown)} message(s) have an unclear outcome`}>
                The provider didn&apos;t confirm whether these were sent (for example after a timeout). They are never resent automatically, to avoid
                duplicate texts.{" "}
                {isAdmin ? "Check with AgooSMS, then record the outcome below." : "An administrator needs to review them."}
              </Alert>
            )}

            {finished && (
              <div className="flex flex-wrap gap-2">
                {failed > 0 && (
                  <Button size="sm" icon="refresh" onClick={askRetry}>
                    Retry failed
                  </Button>
                )}
                {isAdmin && unknown > 0 && (
                  <Button size="sm" icon="fact_check" onClick={() => setResolveOpen(true)}>
                    Review unclear
                  </Button>
                )}
                {c.channel === "sms" && !c.dry_run && c.sent_count > 0 && (
                  <Button size="sm" icon="mark_chat_read" onClick={refreshDelivery} loading={refreshing}>
                    Check delivery status
                  </Button>
                )}
                {isAdmin && (
                  <Button size="sm" variant="danger-ghost" icon="delete" onClick={() => onDelete(c)}>
                    Delete from history
                  </Button>
                )}
              </div>
            )}

            <div>
              <p className="mb-1.5 text-[12px] font-medium text-ink-muted">Message</p>
              <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-muted p-3 text-[13px] leading-relaxed text-ink">
                {c.channel === "sms" && c.include_name_in_sms ? `${c.name}\n${c.body ?? ""}` : c.body}
              </p>
            </div>

            {c.status !== "draft" && (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-ink">Recipients</h3>
                </div>
                <Segmented<RecipientFilter>
                  label="Filter recipients"
                  size="sm"
                  value={filter}
                  onChange={(v) => {
                    setRows(null);
                    setFilter(v);
                  }}
                  options={[
                    { value: "all", label: "All" },
                    { value: "accepted", label: "Accepted" },
                    { value: "failed", label: "Failed", count: failed || undefined },
                    { value: "unknown", label: "Unclear", count: unknown || undefined },
                    { value: "skipped", label: "Skipped" },
                  ]}
                />
                <div className="mt-3">
                  {loadError ? (
                    <p className="text-[13px] text-danger">{loadError}</p>
                  ) : rows === null ? (
                    <div className="space-y-2">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : rows.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[13px] text-ink-muted">No recipients in this view.</p>
                  ) : (
                    <ul className="divide-y divide-line rounded-lg border border-line">
                      {rows.map((r) => (
                        <li key={r.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-ink">
                              {r.member_id ? (
                                <Link href={`/dashboard/members/${r.member_id}`} className="hover:text-brand hover:underline">
                                  {r.name || "Member"}
                                </Link>
                              ) : (
                                r.name || "—"
                              )}
                            </p>
                            <p className="truncate text-[12px] text-ink-muted">
                              {r.status === "skipped" ? "No valid contact" : r.address}
                              {r.delivery_status ? ` · provider: ${r.delivery_status}` : ""}
                            </p>
                            {r.error_message && r.status !== "sent" && r.status !== "simulated" && (
                              <p className="mt-0.5 text-[12px] text-danger">{r.error_message}</p>
                            )}
                          </div>
                          <RecipientStatusBadge status={r.status} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {nextPage !== null && (
                    <Button size="sm" className="mt-2 w-full" onClick={loadMore} loading={loadingMore}>
                      Load more
                    </Button>
                  )}
                </div>
              </div>
            )}

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Activity</h3>
              {audit === null ? (
                <Skeleton className="h-16 w-full" />
              ) : audit.length === 0 ? (
                <p className="text-[13px] text-ink-muted">No activity recorded.</p>
              ) : (
                <ol className="space-y-2 border-l border-line pl-4">
                  {audit.map((a) => (
                    <li key={a.id} className="text-[13px]">
                      <span className="font-medium text-ink">{AUDIT_LABELS[a.action] ?? humanize(a.action)}</span>
                      <span className="text-ink-muted"> · {formatDateTime(a.created_at)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={retryCount !== null}
        onClose={() => setRetryCount(null)}
        onConfirm={confirmRetry}
        title="Retry failed messages?"
        message={
          <>
            <strong className="font-semibold text-ink">{formatNumber(retryCount ?? 0)}</strong> message(s) that the provider definitely did not accept
            will be sent again. Messages with an unclear outcome and invalid numbers are not included.
          </>
        }
        confirmText="Retry now"
        variant="warning"
        icon="refresh"
        isLoading={retrying}
      />

      <Modal
        isOpen={resolveOpen}
        onClose={() => setResolveOpen(false)}
        title="Review unclear outcomes"
        subtitle={`${formatNumber(unknown)} message(s) have no confirmed result.`}
        maxWidth="md"
        isSubmitting={resolving}
        footer={
          <>
            <Button onClick={() => setResolveOpen(false)} disabled={resolving}>
              Cancel
            </Button>
            <Button onClick={() => resolve("sent")} loading={resolving}>
              Mark as sent
            </Button>
            <Button variant="primary" onClick={() => resolve("failed")} loading={resolving}>
              Mark as not sent
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Check the AgooSMS dashboard (or ask recipients) before deciding. <strong className="text-ink">Mark as not sent</strong> lets you retry them;
          <strong className="text-ink"> mark as sent</strong> only if you&apos;ve confirmed they went out. This decision is recorded in the activity log.
        </p>
      </Modal>
    </>
  );
}
