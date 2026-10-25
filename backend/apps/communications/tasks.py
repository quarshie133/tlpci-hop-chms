"""
Celery tasks for sending bulk email and SMS campaigns.

Every task receives the tenant schema name and runs inside `schema_context`,
because Celery workers start on the public schema (django-tenants).

Duplicate-send protection:
  * Recipients are claimed per batch (pending -> sending) before any provider call.
  * A redelivered/duplicate task only processes `pending` recipients.
  * Rows left in `sending` by a crashed worker are marked `unknown` (never resent).
  * Ambiguous provider outcomes (timeouts, 5xx) become `unknown` and need review.
"""

import logging

from celery import shared_task
from django.conf import settings
from django.db import transaction
from django.db.models import Count, F, Q
from django.utils import timezone
from django_tenants.utils import schema_context

logger = logging.getLogger(__name__)

MAX_RATE_LIMIT_RETRIES = 3
# Provider errors that make every further request pointless until an admin acts.
FATAL_ERROR_CODES = {"auth", "insufficient_balance", "not_configured"}


@shared_task(bind=True, max_retries=MAX_RATE_LIMIT_RETRIES)
def send_campaign(self, schema_name: str, campaign_id: str):
    """Dispatch a queued campaign to its pending recipients."""
    with schema_context(schema_name):
        _send_campaign(self, campaign_id)


def _send_campaign(task, campaign_id: str):
    from .models import Campaign, CampaignAuditLog, CampaignRecipient

    started = Campaign.objects.filter(id=campaign_id, status=Campaign.CampaignStatus.SCHEDULED).update(
        status=Campaign.CampaignStatus.SENDING, processing_started_at=timezone.now()
    )
    campaign = Campaign.objects.filter(id=campaign_id).first()
    if campaign is None:
        logger.warning("Campaign %s not found (it may have been deleted); skipping.", campaign_id)
        return
    if not started and campaign.status != Campaign.CampaignStatus.SENDING:
        logger.info("Campaign %s is %s; nothing to do.", campaign_id, campaign.status)
        return
    if started:
        CampaignAuditLog.objects.create(campaign=campaign, action=CampaignAuditLog.Action.PROCESSING)

    # Anything still marked "sending" was interrupted mid-request: outcome unknown, never resend.
    CampaignRecipient.objects.filter(campaign=campaign, status=CampaignRecipient.Status.SENDING).update(
        status=CampaignRecipient.Status.UNKNOWN,
        error_code="interrupted",
        error_message="Processing was interrupted while this message was being sent.",
    )

    if campaign.channel == "sms":
        retry_in = _process_sms(campaign)
        if retry_in is not None:
            if task.request.retries >= MAX_RATE_LIMIT_RETRIES:
                _fail_pending(campaign, "rate_limited", "The SMS provider kept rate limiting requests. Retry later.")
            else:
                raise task.retry(countdown=retry_in)
    else:
        _process_email(campaign)

    finalize_campaign(campaign)


def _claim_batch(campaign, size: int):
    from .models import CampaignRecipient

    with transaction.atomic():
        ids = list(
            CampaignRecipient.objects.select_for_update(skip_locked=True)
            .filter(campaign=campaign, status=CampaignRecipient.Status.PENDING)
            .order_by("address")
            .values_list("id", flat=True)[:size]
        )
        if ids:
            CampaignRecipient.objects.filter(id__in=ids).update(
                status=CampaignRecipient.Status.SENDING, attempts=F("attempts") + 1
            )
    return list(CampaignRecipient.objects.filter(id__in=ids))


def _process_sms(campaign):
    """Send pending SMS in provider-sized batches. Returns a retry delay (seconds) when rate limited."""
    from .models import CampaignRecipient
    from .sms.agoosms import ACCEPTED, AMBIGUOUS, REJECTED, RETRYABLE, get_sms_client
    from .sms.config import SmsNotConfigured, get_sms_settings

    cfg = get_sms_settings()
    try:
        client = get_sms_client()
    except SmsNotConfigured as exc:
        _fail_pending(campaign, "not_configured", str(exc))
        return None

    sender_id = campaign.sender_id or cfg.default_sender_id
    while True:
        batch = _claim_batch(campaign, cfg.max_bulk)
        if not batch:
            return None
        numbers = [r.address for r in batch]
        result = client.send(numbers[0], campaign.body, sender_id) if len(numbers) == 1 else client.send_bulk(numbers, campaign.body, sender_id)
        now = timezone.now()
        by_id = {r.id: r for r in batch}

        if result.outcome == ACCEPTED:
            for r in batch:
                item = result.recipients.get(r.address)
                if item is not None and not item.accepted:
                    r.status, r.error_code, r.error_message = CampaignRecipient.Status.FAILED, "provider_rejected", item.error[:500]
                else:
                    r.status = CampaignRecipient.Status.SIMULATED if result.simulated else CampaignRecipient.Status.SENT
                    r.provider_message_id = (item.message_id if item else "") or result.message_id or result.batch_id
                    r.sent_at, r.error_code, r.error_message = now, "", ""
            CampaignRecipient.objects.bulk_update(by_id.values(), ["status", "provider_message_id", "sent_at", "error_code", "error_message"])
            continue

        if result.outcome == RETRYABLE:
            CampaignRecipient.objects.filter(id__in=by_id).update(
                status=CampaignRecipient.Status.PENDING, error_code=result.error_code, error_message=result.error_message
            )
            if result.error_code == "rate_limited":
                return result.retry_after or 60
            # Network never reached the provider: try once more shortly via Celery retry.
            return 30

        status = CampaignRecipient.Status.FAILED if result.outcome == REJECTED else CampaignRecipient.Status.UNKNOWN
        CampaignRecipient.objects.filter(id__in=by_id).update(
            status=status, error_code=result.error_code, error_message=result.error_message
        )
        if result.outcome == REJECTED and result.error_code in FATAL_ERROR_CODES:
            _fail_pending(campaign, result.error_code, result.error_message)
            campaign.last_error = result.error_message[:500]
            campaign.save(update_fields=["last_error"])
            return None
        if result.outcome == AMBIGUOUS:
            campaign.last_error = result.error_message[:500]
            campaign.save(update_fields=["last_error"])


def _process_email(campaign):
    from django.core.mail import send_mail

    from .models import CampaignRecipient

    while True:
        batch = _claim_batch(campaign, 50)
        if not batch:
            return
        for r in batch:
            try:
                send_mail(campaign.subject, campaign.body, settings.DEFAULT_FROM_EMAIL, [r.address])
                r.status, r.sent_at, r.error_code, r.error_message = CampaignRecipient.Status.SENT, timezone.now(), "", ""
            except Exception as exc:  # noqa: BLE001
                logger.warning("Email to recipient %s failed: %s", r.id, type(exc).__name__)
                r.status, r.error_code, r.error_message = CampaignRecipient.Status.FAILED, "email_error", "The email server rejected the message."
            r.save(update_fields=["status", "sent_at", "error_code", "error_message"])


def _fail_pending(campaign, code: str, message: str):
    from .models import CampaignRecipient

    CampaignRecipient.objects.filter(
        campaign=campaign, status__in=[CampaignRecipient.Status.PENDING, CampaignRecipient.Status.SENDING]
    ).update(status=CampaignRecipient.Status.FAILED, error_code=code, error_message=message[:500])


def finalize_campaign(campaign):
    """Recompute counts from recipient rows and set the final status."""
    from .models import Campaign, CampaignAuditLog, CampaignRecipient

    S = CampaignRecipient.Status
    counts = CampaignRecipient.objects.filter(campaign=campaign).aggregate(
        sent=Count("id", filter=Q(status__in=[S.SENT, S.DELIVERED, S.SIMULATED])),
        failed=Count("id", filter=Q(status__in=[S.FAILED, S.BOUNCED])),
        unknown=Count("id", filter=Q(status=S.UNKNOWN)),
        skipped=Count("id", filter=Q(status=S.SKIPPED)),
        open=Count("id", filter=Q(status__in=[S.PENDING, S.SENDING])),
    )
    campaign.sent_count = counts["sent"]
    campaign.failed_count = counts["failed"]
    campaign.unknown_count = counts["unknown"]
    campaign.skipped_count = counts["skipped"]
    fields = ["sent_count", "failed_count", "unknown_count", "skipped_count"]
    if counts["open"] == 0 and campaign.status in (Campaign.CampaignStatus.SENDING, Campaign.CampaignStatus.NEEDS_REVIEW,
                                                   Campaign.CampaignStatus.PARTIALLY_SENT, Campaign.CampaignStatus.FAILED,
                                                   Campaign.CampaignStatus.SENT):
        if counts["unknown"]:
            campaign.status = Campaign.CampaignStatus.NEEDS_REVIEW
        elif counts["sent"] and not counts["failed"]:
            campaign.status = Campaign.CampaignStatus.SENT
        elif counts["sent"]:
            campaign.status = Campaign.CampaignStatus.PARTIALLY_SENT
        else:
            campaign.status = Campaign.CampaignStatus.FAILED
        now = timezone.now()
        campaign.completed_at = now
        campaign.sent_at = campaign.sent_at or now
        fields += ["status", "completed_at", "sent_at"]
        CampaignAuditLog.objects.create(
            campaign=campaign,
            action=CampaignAuditLog.Action.COMPLETED,
            detail={"status": campaign.status, **{k: counts[k] for k in ("sent", "failed", "unknown", "skipped")}},
        )
    campaign.save(update_fields=fields)
    logger.info("Campaign %s: %s", campaign.id, counts)


@shared_task
def refresh_delivery_status(schema_name: str, campaign_id: str, limit: int = 500):
    """
    Look up provider delivery status for accepted SMS (GET /v1/sms/:id/status).

    AgooSMS reports per *request*: a bulk send returns one message id shared by the whole
    batch, and the status response carries batch counts, e.g.
        {"data": {"messageId": "…", "status": "COMPLETED", "recipientCount": 3,
                  "deliveredCount": 3, "failedCount": 0}}
    Recipients are only marked delivered/failed when the counts make every row's outcome
    certain; a mixed batch keeps "accepted" with the counts recorded, because the provider
    doesn't say which numbers failed.
    """
    from .sms.agoosms import ACCEPTED, get_sms_client
    from .sms.config import SmsNotConfigured

    with schema_context(schema_name):
        from .models import Campaign, CampaignAuditLog, CampaignRecipient

        campaign = Campaign.objects.filter(id=campaign_id, channel="sms").first()
        if campaign is None:
            return
        try:
            client = get_sms_client()
        except SmsNotConfigured:
            return
        S = CampaignRecipient.Status
        rows = list(CampaignRecipient.objects.filter(campaign=campaign, status=S.SENT).exclude(provider_message_id="")[:limit])
        by_message: dict[str, list] = {}
        for r in rows:
            by_message.setdefault(r.provider_message_id, []).append(r)

        updated = 0
        for message_id, group in by_message.items():
            res = client.get_status(message_id)
            if res.outcome != ACCEPTED:
                continue
            report = parse_delivery_report(res.response_summary)
            if not report["status"]:
                continue
            outcome = classify_delivery(report, len(group))
            for r in group:
                r.delivery_status = report["label"][:40]
                if outcome == "delivered":
                    r.status, r.error_code, r.error_message = S.DELIVERED, "", ""
                elif outcome == "failed":
                    r.status, r.error_code, r.error_message = S.FAILED, "undelivered", f"Provider reported: {report['label'][:60]}"
            CampaignRecipient.objects.bulk_update(group, ["delivery_status", "status", "error_code", "error_message"])
            updated += len(group)
        CampaignAuditLog.objects.create(
            campaign=campaign, action=CampaignAuditLog.Action.STATUS_REFRESH,
            detail={"checked": len(rows), "lookups": len(by_message), "updated": updated},
        )
        finalize_campaign(campaign)


def parse_delivery_report(summary: str) -> dict:
    """Extract status and (optional) batch counts from a status response body."""
    import json

    report = {"status": "", "delivered": None, "failed": None, "total": None, "label": ""}
    try:
        body = json.loads(summary)
    except (TypeError, ValueError):
        return report
    data = body.get("data", body) if isinstance(body, dict) else {}
    if not isinstance(data, dict):
        return report
    for key in ("status", "deliveryStatus", "delivery_status", "state"):
        if isinstance(data.get(key), str):
            report["status"] = data[key]
            break

    def _int(*keys):
        for k in keys:
            if isinstance(data.get(k), int):
                return data[k]
        return None

    report["delivered"] = _int("deliveredCount", "delivered_count", "delivered")
    report["failed"] = _int("failedCount", "failed_count", "failed")
    report["total"] = _int("recipientCount", "recipient_count", "total")
    label = report["status"]
    if report["delivered"] is not None and report["total"]:
        label = f"{label} ({report['delivered']}/{report['total']} delivered)"
    report["label"] = label
    return report


DELIVERED_WORDS = {"delivered", "delivrd", "success"}
FAILED_WORDS = {"failed", "undelivered", "rejected", "expired", "undeliv"}


def classify_delivery(report: dict, rows_in_batch: int) -> str:
    """Return "delivered", "failed" or "unchanged" for every row sharing this message id."""
    status = report["status"].lower()
    delivered, failed = report["delivered"], report["failed"]
    if delivered is not None or failed is not None:
        total = report["total"] or rows_in_batch
        if failed == 0 and delivered == total:
            return "delivered"
        if delivered == 0 and failed == total:
            return "failed"
        return "unchanged"  # mixed or still in progress: can't tell which numbers
    if status in DELIVERED_WORDS:
        return "delivered"
    if status in FAILED_WORDS:
        return "failed"
    return "unchanged"


@shared_task
def generate_giving_statements(year: int):
    """Generate annual giving statements for all members (called by Celery Beat)."""
    from apps.members.models import Member
    from apps.finance.models import Contribution
    from django.db.models import Sum

    members = Member.objects.filter(status="active")
    for member in members:
        total = Contribution.objects.filter(
            member=member, date__year=year
        ).aggregate(total=Sum("amount"))["total"] or 0
        logger.info(f"Giving statement for {member}: GHS {total}")
    # TODO: Render PDF and email to member
