# Remaining Work Before Production — TLPCI ChurchMS

Prioritised checklist from the audit on 2026-10-21 (commit `34f45ed`). Evidence and background are in [`CHURCH_SYSTEM_AUDIT.md`](CHURCH_SYSTEM_AUDIT.md).

**Priority:** P0 = blocks launch (security/data integrity) · P1 = required for launch · P2 = should have at launch · P3 = after launch  
**Effort:** S ≤ ½ day · M 1–2 days · L 3–5 days · XL > 1 week  
**Status:** Broken · Missing · Partial · Unverified · Blocked

## First five tasks

1. **P1-1** Stop users promoting themselves to Super Admin
2. **P1-2** Close public registration / superuser creation and tenant-settings hole
3. **P1-3** Switch to Neon direct endpoint (fixes random 500s and duplicate records)
4. **P1-5** Harden production settings and fix password reset
5. **P1-6** Test suite foundation + GitHub Actions CI

---

## Phase 1 — Critical bugs and security

- [ ] **P1-1 · Block self-escalation of role** — P0 · Broken · S
  - **Files:** `backend/apps/accounts/serializers.py`, `backend/apps/accounts/views.py`
  - **Do:**
    - Add a self-profile serializer for `MeView` with `role` and `is_active` read-only.
    - In user admin views, prevent granting a role above the actor's own and prevent editing your own role or active state.
    - Stop `church_admin` from creating `super_admin`.
  - **Depends on:** none
  - **Accept:** `PATCH /auth/me/ {"role":"super_admin"}` leaves the role unchanged. A `church_admin` cannot create or promote a `super_admin` (403). Covered by tests.

- [ ] **P1-2 · Lock down church registration and church settings** — P0 · Broken · M
  - **Files:** `backend/apps/tenants/views.py`, `backend/apps/tenants/urls.py`, `backend/config/urls_public.py`
  - **Do:**
    - Disable or protect `register/` (admin-only or invite token) and add throttling.
    - Create the church admin with `create_user`, not `create_superuser`.
    - Restrict `ChurchDetailView` updates to admins and remove `is_active` and `subscription_plan` from writable fields.
    - Remove tenant module routes from `urls_public.py`.
  - **Depends on:** decision on single- vs multi-church (P1-4)
  - **Accept:** An anonymous POST to registration is rejected (or impossible). No API path creates `is_superuser` users. A non-admin PATCH to `/tenants/me/` returns 403. Tests added.

- [ ] **P1-3 · Fix Neon connection** — P0 · Broken · S
  - **Files:** `backend/.env` (`DATABASE_URL`), `backend/config/settings.py`
  - **Do:**
    - Use Neon's direct (non-pooler) endpoint.
    - Set `CONN_MAX_AGE` (~60) and `CONN_HEALTH_CHECKS=True`.
  - **Depends on:** Neon project access
  - **Accept:** 200 concurrent mixed API requests return no 500s. Group and fund create E2E flows pass. No duplicate records on create.

- [ ] **P1-4 · Decide and enforce tenancy model for user accounts** — P0 · Broken (design) · S if single-church / L if multi-church
  - **Files:** `backend/config/settings.py` (`SHARED_APPS`), `backend/apps/accounts/models.py`, auth backend
  - **Do:**
    - **Single church:** document it, disable registration (P1-2), keep one tenant.
    - **Multi-church:** add a user↔church membership with per-church role, and reject JWTs used on a church the user doesn't belong to.
  - **Depends on:** product decision
  - **Accept:** A user can only access data for churches they belong to (test with two tenants).

- [ ] **P1-5 · Production settings hardening + password reset** — P0 · Broken · M
  - **Files:** `backend/config/settings.py`, `backend/apps/accounts/views.py`, new `frontend/src/app/reset-password/page.tsx`
  - **Do:**
    - Default `DEBUG=False`; require `DJANGO_SECRET_KEY` (fail to start if missing).
    - Set `SECURE_SSL_REDIRECT`, HSTS, secure cookies, `SECURE_PROXY_SSL_HEADER`, `CSRF_TRUSTED_ORIGINS`.
    - Add DRF throttling (login, password reset, registration).
    - Define `FRONTEND_URL`; return the same response for known and unknown emails; use an encoded uid.
    - Build the reset-password page.
    - Restrict `/api/docs/` and `/admin/` in production.
  - **Depends on:** email provider for full reset flow (P2-6)
  - **Accept:** `manage.py check --deploy` reports 0 security warnings with the production env. Repeated bad logins get 429. Password reset returns 200 for both cases and the emailed link resets the password.

- [ ] **P1-6 · Test suite foundation + CI** — P0 · Missing · L
  - **Files:** new `backend/pytest.ini`, `backend/conftest.py`, `backend/apps/*/tests/`, `.github/workflows/ci.yml`
  - **Do:**
    - pytest-django with tenant-aware fixtures (`TenantTestCase` or a test schema).
    - API tests for auth and permissions (P1-1, P1-2, P1-5) and a CRUD smoke test per module.
    - CI runs backend tests against a Postgres service, plus frontend `tsc`, `eslint` and `next build`.
  - **Depends on:** none (write P1-1/2/5 tests alongside)
  - **Accept:** CI is green on PRs; failing tests block merge; coverage report is published.

- [ ] **P1-7 · Make Docker builds safe** — P0 · Broken · S
  - **Files:** `backend/Dockerfile`, new committed `backend/.dockerignore` and `frontend/.dockerignore`, `.gitignore`
  - **Do:**
    - Stop ignoring `.dockerignore`; exclude `.env*`, `venv/`, `pgdata/`, `node_modules/`, `.next/`.
  - **Depends on:** none
  - **Accept:** A built image contains no `.env`, `venv` or `pgdata` (`docker run … ls`).

- [x] **P1-8 · Validate broadcast audience filters** — Done 2026-10-22 (typed audience allow-list, `apps/communications/audience.py`)
  - **Files:** `backend/apps/communications/serializers.py`
  - **Do:** Allow-list audience keys (status, life stage, group membership); reject anything else.
  - **Depends on:** none
  - **Accept:** An unknown filter key returns 400; the valid audiences used by the UI still work.

- [ ] **P1-9 · Revoke refresh token on logout** — P2 · Partial · S
  - **Files:** `frontend/src/lib/auth-context.tsx`, `frontend/src/lib/api.ts`
  - **Do:** Call `/auth/token/blacklist/` on sign-out.
  - **Accept:** After logout the old refresh token can't be refreshed.

## Phase 2 — Incomplete core features

- [x] **P2-1 · Tenant-aware Celery tasks** — Done 2026-10-22 for communications (`schema_context`, broker-failure rollback, `config/__init__.py` now loads the Celery app). Verified with a real worker in test mode.
  - **Files:** `backend/apps/communications/tasks.py`, `backend/apps/communications/views.py`, `backend/config/celery.py`
  - **Do:**
    - Pass the schema name to tasks and run inside `schema_context` (or adopt `tenant-schemas-celery`).
    - In `send`, enqueue before marking queued, or handle broker errors without leaving campaigns stuck.
  - **Depends on:** P1-3
  - **Accept:** A test email campaign to a sandbox recipient completes with correct `sent_count`. A broker outage returns a clear error and the campaign stays `draft`.

- [~] **P2-2 · SMS provider integration (now AgooSMS, replacing Arkesel)** — Implemented and tested in test mode 2026-10-22; see `docs/SMS_AGOOSMS.md`. **Remaining:** API key, approved sender ID, confirmation of AgooSMS response formats and bulk limit, first supervised live send. Original scope:
  - **Files:** `backend/apps/communications/tasks.py` (new provider module), `backend/config/settings.py`, `.env.example`
  - **Do:**
    - Arkesel client (API key and sender ID from env).
    - Fail loudly when not configured (never count as sent).
    - Record provider message IDs; delivery-report webhook if Arkesel supports it.
    - Remove or keep Twilio behind a provider switch.
  - **Depends on:** P2-1, P2-3, Arkesel account/sender ID
  - **Accept:**
    - Sandbox send to a test number succeeds with a provider ID stored.
    - An unconfigured provider marks recipients `failed`.
    - The UI history shows sent and failed counts.
    - No real member numbers are used in testing.

- [~] **P2-3 · Phone number normalisation (Ghana)** — Partial: SMS sending normalises and skips invalid numbers (`apps/communications/sms/phone.py`); stored member numbers still need validation and migration. Original scope:
  - **Files:** `backend/apps/members/models.py`/`serializers.py`, `backend/config/settings.py` (`PHONENUMBER_DEFAULT_REGION`), data migration
  - **Do:** Validate and store E.164 (`+233…`); migrate existing numbers; show validation errors in the UI.
  - **Depends on:** none
  - **Accept:** Invalid numbers are rejected with a clear message; stored numbers are E.164; SMS uses them directly.

- [ ] **P2-4 · Event reminders** — P1 · Missing · L
  - **Files:** `backend/apps/events/models.py` (reminder settings), new `backend/apps/events/tasks.py`, beat schedule, `frontend/src/app/dashboard/events/page.tsx`
  - **Do:**
    - Reminder options per event (offset, channel, audience).
    - Periodic task scans upcoming events per tenant and sends once (idempotent).
    - UI to configure reminders.
  - **Depends on:** P2-1, P2-2, P2-5
  - **Accept:**
    - A reminder fires once at the configured time, in the church's timezone.
    - Duplicates are prevented on worker restart.
    - Covered by a test with a frozen clock.

- [ ] **P2-5 · Church settings: currency, timezone, locale** — P1 · Partial · M
  - **Files:** `backend/apps/tenants/models.py` defaults, `/tenants/me/` (tenant URLconf), new settings page, `frontend/src/lib/format.ts`
  - **Do:** Admin-only church settings page; GHS and Africa/Accra; format money and dates from church settings.
  - **Depends on:** P1-2
  - **Accept:** Currency and timezone changes are reflected across Finance and Events; only admins can edit.

- [ ] **P2-6 · Production email provider** — P1 · Missing · S
  - **Files:** `backend/config/settings.py`, `.env.example`
  - **Do:** Configure SES (AWS) or SendGrid; verify sender domain (SPF/DKIM).
  - **Depends on:** AWS account/domain
  - **Accept:** Password reset and email campaigns arrive in a test inbox.

- [ ] **P2-7 · Reports and exports** — P1 · Missing · L
  - **Files:** new report endpoints in `finance`, `attendance` and `members` views; new `frontend/src/app/dashboard/reports/page.tsx`
  - **Do:**
    - CSV export for people, contributions (date range, fund) and attendance.
    - Monthly giving by fund; membership growth.
  - **Depends on:** list of required reports from church
  - **Accept:** Exports match on-screen totals for the same filters; finance reports are restricted per role decision.

- [ ] **P2-8 · Annual giving statements** — P2 · Missing · L
  - **Files:** `backend/apps/communications/tasks.py` (`generate_giving_statements`)
  - **Do:** Generate per-member PDF statements for a year; preview and download in the UI; optional email.
  - **Depends on:** P2-1, P2-6, P2-9
  - **Accept:** Statement totals equal the sum of that member's contributions for the year.

- [ ] **P2-9 · File uploads to S3** — P2 · Missing · M
  - **Files:** `backend/config/settings.py` (move to `STORAGES`), upload endpoints, `frontend/src/lib/api.ts` (multipart), members, sermons and church-logo UI
  - **Do:**
    - Tenant-prefixed upload paths; size and type validation; private bucket with presigned URLs.
    - Member photo, sermon media/notes and church logo.
  - **Depends on:** S3 bucket (P3-3)
  - **Accept:** An uploaded photo displays via a presigned URL; files over the limit or of the wrong type are rejected.

- [ ] **P2-10 · Finance access by role** — P1 · Partial · S
  - **Files:** `backend/apps/accounts/permissions.py`, `backend/apps/finance/views.py`, frontend nav
  - **Do:** Restrict finance to an agreed set of roles (e.g. admins plus a finance role).
  - **Depends on:** church decision
  - **Accept:** Unauthorised staff get 403 and don't see the Finance menu.

- [ ] **P2-11 · Smaller functional gaps** — P2 · Partial · M total
  - Family list/edit/delete screen (`members/families/` API exists).
  - RSVP add and manage UI.
  - Edit and delete pastoral notes.
  - Restore a removed group member (soft-delete `unique_together` conflict in `backend/apps/groups/views.py`).
  - Link pledge `paid_amount` to pledge-payment contributions.
  - Message templates UI.
  - **Accept:** Each flow works end-to-end with a test.

- [ ] **P2-12 · Verify built-but-unexercised flows** — P1 · Unverified · M
  - Attendance check-in, sermons CRUD, pledges, contributions edit/delete, user management, change password, full Add Person form, token refresh after expiry.
  - **Depends on:** P1-3
  - **Accept:** E2E (Playwright) script covers each flow and passes in CI or staging.

## Phase 3 — Production infrastructure and deployment

- [ ] **P3-1 · Production Docker images** — P0 · Broken · M
  - **Files:** `backend/Dockerfile`, `frontend/Dockerfile`, new `docker-compose.prod.yml` (optional)
  - **Do:**
    - Multi-stage builds, non-root user.
    - Backend `CMD` gunicorn (+ `collectstatic`).
    - Frontend `next build` + `next start` (or standalone output).
    - Separate worker and beat commands.
    - Split requirements into base, prod and dev.
  - **Depends on:** P1-7
  - **Accept:** Images build in CI and run with only env vars. A health check passes. No dev servers in images.

- [ ] **P3-2 · AWS deployment** — P0 · Missing · XL
  - **Files:** new IaC (Terraform/CDK) or ECS task definitions; `.github/workflows/deploy.yml`
  - **Do:**
    - ECS Fargate (or App Runner) for web, worker and beat; ALB with HTTPS (ACM); ElastiCache Redis.
    - Secrets in AWS Secrets Manager/SSM.
    - Migrations (`migrate_schemas`) as a one-off deploy task.
    - Separate staging and production.
  - **Depends on:** P3-1, P1-5, AWS account
  - **Accept:**
    - Staging deploys automatically from `main`; production deploys on a tagged release with approval.
    - Rollback is documented and tested.

- [ ] **P3-3 · S3 buckets** — P1 · Missing · S
  - **Do:** Private bucket with block-public-access, versioning, lifecycle rules, an IAM role for the app (no static keys), and CORS for uploads.
  - **Depends on:** AWS account
  - **Accept:** The app reads and writes via its IAM role; the bucket is not publicly listable.

- [ ] **P3-4 · Logging, monitoring, alerting** — P0 · Missing · M
  - **Files:** `backend/config/settings.py` (`LOGGING`, Sentry init), new `/health/` endpoint
  - **Do:**
    - JSON logs to stdout → CloudWatch Logs; initialise Sentry (already installed) or CloudWatch error alarms.
    - Alarms on 5xx rate, latency, Celery queue depth and failed tasks, and database connections.
    - Uptime check.
  - **Depends on:** P3-2
  - **Accept:** A forced error appears in CloudWatch or Sentry within a minute, and an alarm notifies the on-call email.

- [ ] **P3-5 · Backups and restore** — P0 · Unverified · S
  - **Do:** Confirm the Neon plan's point-in-time-restore window; schedule an extra logical backup (`pg_dump`) to S3; write and rehearse a restore runbook.
  - **Depends on:** Neon and AWS access
  - **Accept:** A restore to a branch or new database is performed and documented with timings.

- [ ] **P3-6 · Clean production database** — P0 · Partial · S
  - **Do:**
    - Provision a fresh production Neon project or branch; run migrations.
    - Create the real church tenant and admins.
    - Remove demo accounts and the known shared password from any shared database (the demo seed script `seed_tlpci.py` was removed on 2026-10-25).
  - **Depends on:** P1-3
  - **Accept:** The production database contains no seed or demo records.

- [ ] **P3-7 · Documentation** — P2 · Partial · S
  - **Files:** `README.md`, `.env.example`
  - **Do:** Correct the stack and folder layout; document env vars (including `DATABASE_URL`, Arkesel, `FRONTEND_URL`), deploy, migrations and runbooks.
  - **Accept:** A new developer can run the stack from the README alone.

- [ ] **P3-8 · Dependency upgrades** — P2 · Partial · M
  - **Do:** Upgrade Django 5.0 → 5.2 LTS (move to `STORAGES`); remove unused packages; add `pip-audit` and `npm audit` to CI.
  - **Depends on:** P1-6
  - **Accept:** Tests are green after the upgrade; the audit step has no high-severity findings.

## Phase 4 — Final testing and launch

- [ ] **P4-1 · Security review** — P0 · S–M
  - **Do:** Re-test S1–S10 from the audit; OWASP checks (authz on every endpoint per role, IDOR, XSS, rate limits); a dependency audit.
  - **Depends on:** Phase 1
  - **Accept:** No open critical or high findings.

- [ ] **P4-2 · Load and concurrency test on staging** — P1 · S
  - **Do:** ~50 concurrent users on the dashboard and lists; bulk SMS to a sandbox list.
  - **Depends on:** P3-2
  - **Accept:** p95 < 1 s for list endpoints, no 5xx, no duplicate writes.

- [ ] **P4-3 · User acceptance testing with church staff** — P0 · M
  - **Do:** Scripted UAT for each role (admin, pastor, staff, finance) across all modules, on desktop and phone.
  - **Accept:** Sign-off from the church admin; all blocking issues fixed.

- [ ] **P4-4 · Data migration / onboarding** — P1 · M
  - **Do:** Import existing member and giving records (CSV import tool or script), with a validation report.
  - **Depends on:** P2-3, P3-6
  - **Accept:** Imported counts and totals reconcile with the source.

- [ ] **P4-5 · Launch readiness** — P0 · S
  - **Do:** DNS and TLS; final `check --deploy`; backups verified; alarms tested; rollback plan; staff training session; support contact.
  - **Accept:** Go/no-go checklist signed off.

---

## Summary

| Category | Count | Items |
|---|---|---|
| ✅ Complete & verified | 9 | Login, dashboard, people list/search/CRUD, events CRUD, SMS draft composing, responsive UI, error states, auth guard, frontend build/lint |
| 🟦 Implemented, unverified | 10 | Token refresh, change password, user management, full profile form, pastoral notes, attendance & check-in, sermons, contributions, pledges, tenant schema isolation |
| 🟨 Partially complete | 12 | Logout, RBAC, church locale, families, RSVPs, message templates, audience filters, S3 config, compose file, API exposure, docs, dependencies |
| ⬜ Missing | 17 | Arkesel, event reminders, event recurrence, reports/exports, giving statements, notifications, uploads, self-service portal, throttling, email provider, tests, CI/CD, AWS deploy, logging, monitoring, health check, reset-password page |
| 🟥 Broken | 12 | Self-escalation, registration superuser, church settings authz, public URLconf, global users, password reset, Neon pooler, Celery tenancy, false "sent" status, phone format, broker-failure state, Docker secrets |
| ⛔ Blocked | 3 | Groups CRUD, group roster, funds (all blocked by P1-3) |
| ❔ Unverifiable here | 4 | Real SMS/email delivery, S3, AWS/CloudWatch, Neon backups |
