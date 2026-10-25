"use client";

import { useState, type SyntheticEvent } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth, PASTOR_ROLES } from "@/lib/auth-context";
import {
  contributionsApi,
  errorMessage,
  familiesApi,
  listAll,
  membersApi,
  type Family,
  type MemberDetail,
} from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import {
  formatDate,
  formatDateTime,
  CHURCH_CURRENCY,
  formatMoney,
  GENDERS,
  initials,
  labelFor,
  LIFE_STAGES,
  MARITAL_STATUSES,
  CONTRIBUTION_TYPES,
  PAYMENT_METHODS,
  relativeTime,
} from "@/lib/format";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Field, Textarea } from "@/components/ui/form";
import { MemberStatusBadge } from "@/components/domain";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  DetailList,
  EmptyState,
  ErrorState,
  Icon,
  Segmented,
  Skeleton,
  TableSkeleton,
} from "@/components/ui/primitives";
import {
  formToPayload,
  MemberFullForm,
  memberToForm,
  validateMember,
  type MemberFormErrors,
  type MemberFormValues,
  emptyMember,
} from "@/components/member-form";

type Tab = "overview" | "household" | "giving" | "notes";

export default function MemberProfilePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { token, user, hasRole } = useAuth();
  const toast = useToast();
  const t = token ?? "";
  const canSeeNotes = hasRole(...PASTOR_ROLES);

  const [tab, setTab] = useState<Tab>("overview");
  const record = useAsync(token && id ? () => membersApi.detail(t, id) : null, [token, id]);
  const member = record.data;

  // ── Edit ───────────────────────────────────────────────────────────────
  const [editOpen, setEditOpen] = useState(false);
  const [values, setValues] = useState<MemberFormValues>(emptyMember);
  const [errors, setErrors] = useState<MemberFormErrors>({});
  const [apiError, setApiError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [families, setFamilies] = useState<Family[]>([]);

  const set = <K extends keyof MemberFormValues>(key: K, value: MemberFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const openEdit = () => {
    if (!member) return;
    setValues(memberToForm(member));
    setErrors({});
    setApiError(null);
    setEditOpen(true);
    if (token && families.length === 0) {
      listAll(familiesApi.list, token, "ordering=name").then(setFamilies).catch(() => setFamilies([]));
    }
  };

  const handleSave = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (!token || !member || saving) return;
    const v = validateMember(values);
    setErrors(v);
    if (Object.keys(v).length) return;
    setSaving(true);
    setApiError(null);
    try {
      const updated = (await membersApi.update(token, member.id, formToPayload(values))) as unknown as MemberDetail;
      record.setData(updated);
      toast.success("Profile updated", `${updated.full_name}'s profile was saved.`);
      setEditOpen(false);
    } catch (err) {
      setApiError(err);
    } finally {
      setSaving(false);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    if (!token || !member || deleting) return;
    setDeleting(true);
    try {
      await membersApi.remove(token, member.id);
      toast.success("Person removed", `${member.full_name} was removed from the directory.`);
      router.push("/dashboard/members");
    } catch (err) {
      toast.error("Couldn't remove person", errorMessage(err));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (record.loading && !member) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <Card className="p-6">
          <div className="flex items-center gap-4">
            <Skeleton className="h-16 w-16 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-4 w-80 max-w-full" />
            </div>
          </div>
        </Card>
        <Card>
          <TableSkeleton rows={4} />
        </Card>
      </div>
    );
  }

  if (record.error || !member) {
    return (
      <Card>
        <ErrorState message={record.error ?? "This person could not be found."} onRetry={record.reload} />
        <div className="flex justify-center pb-8">
          <ButtonLink href="/dashboard/members" icon="arrow_back" variant="ghost">
            Back to people
          </ButtonLink>
        </div>
      </Card>
    );
  }

  const tabs: Array<{ value: Tab; label: string; icon: string }> = [
    { value: "overview", label: "Overview", icon: "badge" },
    { value: "household", label: "Household", icon: "family_restroom" },
    { value: "giving", label: "Giving", icon: "volunteer_activism" },
    ...(canSeeNotes ? [{ value: "notes" as Tab, label: "Pastoral notes", icon: "lock" }] : []),
  ];

  const addressLine = [member.address, [member.city, member.state].filter(Boolean).join(", "), member.postal_code, member.country]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-6">
      {/* ── Identity header ──────────────────────────────────────────── */}
      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4">
            <Avatar name={member.full_name} initials={initials(member.first_name, member.last_name)} src={member.photo} size={64} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-ink">{member.full_name}</h1>
                <MemberStatusBadge status={member.status} />
              </div>
              {member.preferred_name && <p className="text-sm text-ink-muted">Goes by “{member.preferred_name}”</p>}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-muted">
                {member.life_stage && (
                  <span className="inline-flex items-center gap-1">
                    <Icon name="person" size={16} />
                    {labelFor(LIFE_STAGES, member.life_stage)}
                    {member.age !== null ? `, ${member.age} yrs` : ""}
                  </span>
                )}
                {member.family && (
                  <span className="inline-flex items-center gap-1">
                    <Icon name="family_restroom" size={16} />
                    {member.family.name}
                  </span>
                )}
                {member.membership_date && (
                  <span className="inline-flex items-center gap-1">
                    <Icon name="calendar_month" size={16} />
                    Member since {formatDate(member.membership_date, { month: "short", year: "numeric" })}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {member.phone_mobile && (
              <a href={`tel:${member.phone_mobile}`} className="btn btn-secondary btn-sm">
                <Icon name="call" size={18} />
                Call
              </a>
            )}
            {member.email && (
              <a href={`mailto:${member.email}`} className="btn btn-secondary btn-sm">
                <Icon name="mail" size={18} />
                Email
              </a>
            )}
            <Button size="sm" variant="primary" icon="edit" onClick={openEdit}>
              Edit profile
            </Button>
            <Button size="sm" variant="danger-ghost" iconOnly icon="delete" aria-label={`Remove ${member.full_name}`} title="Remove person" onClick={() => setConfirmDelete(true)} />
          </div>
        </div>
      </Card>

      <Segmented<Tab> label="Profile sections" value={tab} onChange={setTab} options={tabs} />

      {tab === "overview" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Contact" icon="contact_mail" />
            <div className="px-5 pb-5">
              <DetailList
                items={[
                  { label: "Email", value: member.email ? <a className="text-brand hover:underline" href={`mailto:${member.email}`}>{member.email}</a> : null },
                  { label: "Mobile phone", value: member.phone_mobile },
                  { label: "Home phone", value: member.phone_home },
                  { label: "Work phone", value: member.phone_work },
                ]}
              />
              <div className="mt-4 border-t border-line pt-4">
                <DetailList columns={1} items={[{ label: "Address", value: addressLine }]} />
              </div>
            </div>
          </Card>
          <Card>
            <CardHeader title="Personal" icon="person" />
            <div className="px-5 pb-5">
              <DetailList
                items={[
                  { label: "Gender", value: member.gender ? labelFor(GENDERS, member.gender) : null },
                  { label: "Date of birth", value: member.date_of_birth ? `${formatDate(member.date_of_birth)}${member.age !== null ? ` (${member.age})` : ""}` : null },
                  { label: "Marital status", value: member.marital_status ? labelFor(MARITAL_STATUSES, member.marital_status) : null },
                  { label: "Occupation", value: [member.occupation, member.employer].filter(Boolean).join(" at ") },
                ]}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="Church membership" icon="church" />
            <div className="px-5 pb-5">
              <DetailList
                items={[
                  { label: "Status", value: <MemberStatusBadge status={member.status} /> },
                  { label: "Life stage", value: member.life_stage ? labelFor(LIFE_STAGES, member.life_stage) : null },
                  { label: "Membership date", value: member.membership_date ? formatDate(member.membership_date) : null },
                  { label: "Baptism date", value: member.baptism_date ? formatDate(member.baptism_date) : null },
                ]}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="Notes" icon="sticky_note_2" description="General notes visible to staff" />
            <div className="px-5 pb-5">
              {member.notes ? (
                <p className="whitespace-pre-wrap text-sm text-ink">{member.notes}</p>
              ) : (
                <p className="text-[13px] text-ink-muted">No general notes on this profile.</p>
              )}
              <p className="mt-4 text-[12px] text-ink-subtle">
                Record created {formatDate(member.created_at)} · last updated {relativeTime(member.updated_at)}
              </p>
            </div>
          </Card>
        </div>
      )}

      {tab === "household" && <HouseholdTab member={member} token={t} onEdit={openEdit} />}
      {tab === "giving" && <GivingTab memberId={member.id} token={t} />}
      {tab === "notes" && canSeeNotes && <NotesTab memberId={member.id} token={t} currentUserId={user?.id} />}

      {/* Edit dialog */}
      <Modal
        isOpen={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit profile"
        subtitle={`Update ${member.full_name}'s details.`}
        maxWidth="2xl"
        isSubmitting={saving}
        footer={
          <>
            <Button onClick={() => setEditOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="member-edit-form" variant="primary" loading={saving}>
              Save changes
            </Button>
          </>
        }
      >
        <form id="member-edit-form" onSubmit={handleSave} noValidate className="flex flex-col gap-5">
          {apiError ? <Alert title="Couldn't save changes">{errorMessage(apiError)}</Alert> : null}
          <MemberFullForm values={values} set={set} errors={errors} apiError={apiError} disabled={saving} families={families} />
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        title="Remove person?"
        message={
          <>
            <strong className="font-semibold text-ink">{member.full_name}</strong> will be permanently removed, along with their pastoral notes,
            attendance and group memberships. Giving records are kept but unlinked. This can&apos;t be undone.
          </>
        }
        confirmText="Remove person"
        isLoading={deleting}
      />
    </div>
  );
}

/* ── Household tab ───────────────────────────────────────────────────── */
function HouseholdTab({ member, token, onEdit }: { member: MemberDetail; token: string; onEdit: () => void }) {
  const fam = member.family;
  const relatives = useAsync(fam ? () => membersApi.list(token, `family=${fam.id}&page_size=50`) : null, [fam?.id]);

  if (!fam) {
    return (
      <Card>
        <EmptyState
          icon="family_restroom"
          title="Not linked to a household"
          description="Link this person to a family to see everyone in their household together."
          action={
            <Button icon="edit" onClick={onEdit}>
              Edit profile
            </Button>
          }
        />
      </Card>
    );
  }

  const famAddress = [fam.address, [fam.city, fam.state].filter(Boolean).join(", "), fam.postal_code].filter(Boolean).join(" · ");

  return (
    <Card>
      <CardHeader title={fam.name} description={famAddress || "No household address on record"} icon="family_restroom" />
      <div className="px-2 pb-3">
        {relatives.loading ? (
          <TableSkeleton rows={3} cols={2} />
        ) : relatives.error ? (
          <ErrorState compact message={relatives.error} onRetry={relatives.reload} />
        ) : (
          <ul className="flex flex-col">
            {(relatives.data?.results ?? []).map((m) => (
              <li key={m.id}>
                <Link
                  href={`/dashboard/members/${m.id}`}
                  aria-current={m.id === member.id ? "page" : undefined}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-canvas aria-[current=page]:bg-brand-softer"
                >
                  <Avatar name={m.full_name} initials={initials(m.first_name, m.last_name)} src={m.photo} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">
                      {m.full_name}
                      {m.id === member.id && <span className="ml-1.5 text-[12px] font-normal text-ink-muted">(this profile)</span>}
                    </span>
                    <span className="block text-[13px] text-ink-muted">
                      {labelFor(LIFE_STAGES, m.life_stage)}
                      {m.age !== null ? ` · ${m.age} yrs` : ""}
                    </span>
                  </span>
                  <MemberStatusBadge status={m.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/* ── Giving tab ──────────────────────────────────────────────────────── */
function GivingTab({ memberId, token }: { memberId: string; token: string }) {
  const giving = useAsync(() => contributionsApi.list(token, `member=${memberId}&ordering=-date&page_size=50`), [memberId]);
  const rows = giving.data?.results ?? [];
  const year = new Date().getFullYear();
  const ytd = rows.filter((c) => c.date.startsWith(String(year))).reduce((s, c) => s + parseFloat(c.amount || "0"), 0);
  const currency = rows[0]?.currency || CHURCH_CURRENCY;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Giving history"
        icon="volunteer_activism"
        description={giving.data ? `${giving.data.count} contribution${giving.data.count === 1 ? "" : "s"} on record` : undefined}
        actions={
          rows.length > 0 ? (
            <div className="text-right">
              <p className="text-[12px] text-ink-muted">{year} total{giving.data && giving.data.count > rows.length ? " (latest 50)" : ""}</p>
              <p className="text-lg font-semibold tabular-nums text-ink">{formatMoney(ytd, currency)}</p>
            </div>
          ) : undefined
        }
      />
      {giving.loading ? (
        <TableSkeleton rows={3} cols={3} />
      ) : giving.error ? (
        <ErrorState compact message={giving.error} onRetry={giving.reload} />
      ) : rows.length === 0 ? (
        <EmptyState compact icon="savings" title="No giving recorded" description="Contributions linked to this person will appear here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Fund</th>
                <th scope="col">Type</th>
                <th scope="col">Method</th>
                <th scope="col" className="num">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="whitespace-nowrap">{formatDate(c.date)}</td>
                  <td>{c.fund_name}</td>
                  <td className="text-ink-muted">{labelFor(CONTRIBUTION_TYPES, c.contribution_type)}</td>
                  <td className="text-ink-muted">{labelFor(PAYMENT_METHODS, c.payment_method)}</td>
                  <td className="num font-medium">{formatMoney(c.amount, c.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ── Pastoral notes tab ──────────────────────────────────────────────── */
function NotesTab({ memberId, token, currentUserId }: { memberId: string; token: string; currentUserId?: number }) {
  const toast = useToast();
  const notes = useAsync(() => membersApi.notes(token, memberId), [memberId]);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const note = text.trim();
    if (!note) {
      setError("Write a note before saving.");
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      const created = await membersApi.addNote(token, memberId, note);
      notes.setData([created, ...(notes.data ?? [])]);
      setText("");
      toast.success("Note saved", "The pastoral note was added to this profile.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <Card className="p-5 lg:col-span-5 lg:self-start">
        <h2 className="text-[15px] font-semibold text-ink">Add a pastoral note</h2>
        <p className="mt-0.5 text-[13px] text-ink-muted">Visible only to pastors and administrators.</p>
        <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
          <Field label="Note" required error={error || undefined}>
            {(p) => (
              <Textarea
                {...p}
                rows={5}
                value={text}
                disabled={saving}
                placeholder="Prayer request, visit summary, follow-up needed…"
                onChange={(e) => {
                  setText(e.target.value);
                  setError("");
                }}
              />
            )}
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" icon="add" loading={saving}>
              Save note
            </Button>
          </div>
        </form>
      </Card>

      <Card className="lg:col-span-7">
        <CardHeader title="Pastoral history" icon="lock" description="Most recent first" />
        <div className="px-5 pb-5">
          {notes.loading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : notes.error ? (
            notes.error.includes("permission") ? (
              <Alert tone="warning">Your role can&apos;t view pastoral notes.</Alert>
            ) : (
              <ErrorState compact message={notes.error} onRetry={notes.reload} />
            )
          ) : !notes.data || notes.data.length === 0 ? (
            <EmptyState compact icon="edit_note" title="No pastoral notes yet" description="Notes you add will be listed here." />
          ) : (
            <ol className="flex flex-col gap-3">
              {notes.data.map((n) => (
                <li key={n.id} className="rounded-lg border border-line bg-surface-muted p-3.5">
                  <div className="flex items-center justify-between gap-2 text-[12px] text-ink-muted">
                    <Badge tone={n.created_by_user_id === currentUserId ? "brand" : "neutral"}>
                      {n.created_by_user_id === currentUserId ? "You" : `Staff user #${n.created_by_user_id}`}
                    </Badge>
                    <time dateTime={n.created_at} title={formatDateTime(n.created_at)}>
                      {relativeTime(n.created_at)}
                    </time>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{n.note}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Card>
    </div>
  );
}

