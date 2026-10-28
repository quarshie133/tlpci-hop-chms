import logging

from django.db import connection, transaction
from django.db.models import Count
from django.utils import timezone
from rest_framework import status as http_status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework.viewsets import ModelViewSet

from apps.accounts.permissions import IsAdminOrAbove, IsStaffOrAbove

from .audience import resolve_audience, validate_audience
from .models import Campaign, CampaignAuditLog, CampaignRecipient, MessageTemplate, compose_sms
from .serializers import (
    AudiencePreviewSerializer,
    CampaignAuditLogSerializer,
    CampaignRecipientSerializer,
    CampaignSerializer,
    MessageTemplateSerializer,
    ResolveUnknownSerializer,
    SendCampaignSerializer,
)
from .sms.config import get_sms_settings
from .sms.segments import sms_segments
from .tasks import finalize_campaign, refresh_delivery_status, send_campaign

logger = logging.getLogger(__name__)

FULL_ADDRESS_ROLES = ("super_admin", "church_admin", "pastor")
# Error codes that won't be fixed by retrying (bad number, provider rejected content).
NON_RETRYABLE_CODES = ("invalid_phone", "no_contact", "validation", "provider_rejected", "undelivered")


def _error(detail: str, code: str, status: int, **extra):
    return Response({"detail": detail, "code": code, **extra}, status=status)


def _sms_unavailable_response():
    cfg = get_sms_settings()
    if cfg.dry_run or cfg.can_send_real:
        return None
    missing = "API key" if not cfg.api_key_available else "approved sender ID"
    return _error(
        f"SMS sending isn't configured yet (missing AgooSMS {missing}). Ask an administrator to finish the SMS setup.",
        "sms_not_configured",
        http_status.HTTP_503_SERVICE_UNAVAILABLE,
    )


class MessageTemplateViewSet(ModelViewSet):
    serializer_class = MessageTemplateSerializer
    permission_classes = [IsStaffOrAbove]
    queryset = MessageTemplate.objects.all()
    filterset_fields = ["channel"]


class CampaignViewSet(ModelViewSet):
    serializer_class = CampaignSerializer
    permission_classes = [IsStaffOrAbove]
    queryset = Campaign.objects.all()
    filterset_fields = ["channel", "status"]

    def filter_queryset(self, queryset):
        # filterset_fields (channel/status) describe the campaign *list*. Applying them in
        # get_object() for detail actions made query params like ?status=failed (meant for
        # recipients) change or break which campaign was found.
        if self.action != "list":
            return queryset
        return super().filter_queryset(queryset)

    def get_throttles(self):
        if self.action in ("send", "retry_failed"):
            self.throttle_scope = "sms_send"
            return [ScopedRateThrottle()]
        return super().get_throttles()

    # ── CRUD guards ─────────────────────────────────────────────────────
    def perform_create(self, serializer):
        campaign = serializer.save(created_by_user_id=self.request.user.id)
        CampaignAuditLog.objects.create(campaign=campaign, action=CampaignAuditLog.Action.CREATED, user_id=self.request.user.id)

    def perform_update(self, serializer):
        if serializer.instance.status != Campaign.CampaignStatus.DRAFT:
            raise ValidationError({"detail": "Only drafts can be edited. Sent broadcasts are kept as a record."})
        campaign = serializer.save()
        CampaignAuditLog.objects.create(campaign=campaign, action=CampaignAuditLog.Action.UPDATED, user_id=self.request.user.id)

    def destroy(self, request, *args, **kwargs):
        """
        Drafts: any staff member. Finished broadcasts (sent, partially sent, failed, needs review):
        church admins only, since this removes the recipient results and activity log.
        Queued/sending broadcasts can't be deleted while a worker may be sending them.
        """
        campaign = self.get_object()
        S = Campaign.CampaignStatus
        if campaign.status in (S.SCHEDULED, S.SENDING):
            return _error(
                "This broadcast is being sent and can't be deleted until it finishes.",
                "in_progress", http_status.HTTP_409_CONFLICT,
            )
        if campaign.status != S.DRAFT and not getattr(request.user, "is_admin_or_above", False):
            return _error(
                "Only church administrators can delete sent or failed broadcasts.",
                "admin_required", http_status.HTTP_403_FORBIDDEN,
            )
        logger.info(
            "Campaign %s (%s, status=%s, sent=%s, failed=%s) deleted by user %s",
            campaign.id, campaign.channel, campaign.status, campaign.sent_count, campaign.failed_count, request.user.id,
        )
        return super().destroy(request, *args, **kwargs)

    # ── Preview ─────────────────────────────────────────────────────────
    @action(detail=False, methods=["post"])
    def preview(self, request):
        ser = AudiencePreviewSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        res = resolve_audience(ser.validated_data["recipients_filter"], ser.validated_data["channel"])
        cfg = get_sms_settings()
        data = res.summary()
        if ser.validated_data["channel"] == "sms":
            v = ser.validated_data
            seg = sms_segments(compose_sms(v.get("name", ""), v.get("body") or "", v.get("include_name_in_sms", False)))
            data.update(
                segments_per_message=seg["segments"],
                encoding=seg["encoding"],
                characters=seg["length"],
                estimated_segments=seg["segments"] * len(res.valid),
            )
        data.update(
            requires_confirmation=len(res.valid) >= cfg.large_broadcast_threshold,
            max_recipients=cfg.max_recipients,
        )
        return Response(data)

    # ── Send ────────────────────────────────────────────────────────────
    @action(detail=True, methods=["post"])
    def send(self, request, pk=None):
        params = SendCampaignSerializer(data=request.data)
        params.is_valid(raise_exception=True)
        campaign = self.get_object()
        if campaign.channel == "sms":
            unavailable = _sms_unavailable_response()
            if unavailable:
                return unavailable
        cfg = get_sms_settings()

        with transaction.atomic():
            campaign = Campaign.objects.select_for_update().get(pk=campaign.pk)
            if campaign.status != Campaign.CampaignStatus.DRAFT:
                return _error("This broadcast has already been sent or is being sent.", "already_sent", http_status.HTTP_409_CONFLICT)
            try:
                spec = validate_audience(campaign.recipients_filter or {}, campaign.channel)
            except ValidationError as exc:
                return _error(f"The saved audience is no longer valid: {exc.detail}", "invalid_audience", http_status.HTTP_400_BAD_REQUEST)

            res = resolve_audience(spec, campaign.channel)
            count = len(res.valid)
            if count == 0:
                return _error("No one in this audience has a valid contact to send to.", "no_recipients", http_status.HTTP_400_BAD_REQUEST, **res.summary())
            if count > cfg.max_recipients:
                return _error(
                    f"This audience has {count} recipients; the limit per broadcast is {cfg.max_recipients}.",
                    "too_many_recipients", http_status.HTTP_400_BAD_REQUEST,
                )
            confirm = params.validated_data.get("confirm_recipient_count")
            if count >= cfg.large_broadcast_threshold and confirm != count:
                return _error(
                    f"Please confirm sending to {count} people.", "confirmation_required",
                    http_status.HTTP_400_BAD_REQUEST, recipient_count=count,
                )

            S = CampaignRecipient.Status
            rows = [CampaignRecipient(campaign=campaign, member_id=c.member_id, name=c.name, address=c.address, status=S.PENDING) for c in res.valid]
            for c, code, msg in [(c, "invalid_phone" if campaign.channel == "sms" else "invalid_email", "Not a valid contact.") for c in res.invalid] + [
                (c, "no_contact", "No contact details on file.") for c in res.missing
            ]:
                # Skipped people are recorded for transparency; address must stay unique per campaign.
                rows.append(CampaignRecipient(campaign=campaign, member_id=c.member_id, name=c.name,
                                              address=f"skipped:{c.member_id}", status=S.SKIPPED, error_code=code, error_message=msg))
            CampaignRecipient.objects.bulk_create(rows, ignore_conflicts=True)

            campaign.recipients_filter = spec
            campaign.status = Campaign.CampaignStatus.SCHEDULED
            campaign.recipient_count = count
            campaign.skipped_count = len(res.invalid) + len(res.missing)
            campaign.sent_by_user_id = request.user.id
            campaign.scheduled_at = timezone.now()
            campaign.dry_run = cfg.dry_run if campaign.channel == "sms" else False
            campaign.last_error = ""
            if campaign.channel == "sms" and not campaign.sender_id:
                campaign.sender_id = cfg.default_sender_id
            campaign.save()
            CampaignAuditLog.objects.create(
                campaign=campaign, action=CampaignAuditLog.Action.QUEUED, user_id=request.user.id,
                detail={"recipients": count, "skipped": campaign.skipped_count, "dry_run": campaign.dry_run, "sender_id": campaign.sender_id},
            )

        if not self._enqueue(campaign, request):
            return _error(
                "The message queue is unavailable, so nothing was sent. Please try again shortly.",
                "queue_unavailable", http_status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response(
            {"detail": "Broadcast queued.", "dry_run": campaign.dry_run, "recipient_count": count, "skipped": campaign.skipped_count},
            status=http_status.HTTP_202_ACCEPTED,
        )

    def _enqueue(self, campaign, request) -> bool:
        try:
            send_campaign.delay(connection.schema_name, str(campaign.id))
            return True
        except Exception as exc:  # noqa: BLE001 — broker down
            logger.error("Could not queue campaign %s: %s", campaign.id, type(exc).__name__)
            with transaction.atomic():
                CampaignRecipient.objects.filter(campaign=campaign).delete()
                Campaign.objects.filter(pk=campaign.pk).update(
                    status=Campaign.CampaignStatus.DRAFT, recipient_count=0, skipped_count=0, dry_run=False,
                    scheduled_at=None, sent_by_user_id=None, last_error="Message queue unavailable; nothing was sent.",
                )
                CampaignAuditLog.objects.create(campaign=campaign, action=CampaignAuditLog.Action.QUEUE_FAILED, user_id=request.user.id)
            return False

    # ── Retry definitively failed recipients ────────────────────────────
    @action(detail=True, methods=["post"], url_path="retry-failed")
    def retry_failed(self, request, pk=None):
        params = SendCampaignSerializer(data=request.data)
        params.is_valid(raise_exception=True)
        campaign = self.get_object()
        if campaign.channel == "sms":
            unavailable = _sms_unavailable_response()
            if unavailable:
                return unavailable
        with transaction.atomic():
            campaign = Campaign.objects.select_for_update().get(pk=campaign.pk)
            if campaign.status not in (Campaign.CampaignStatus.FAILED, Campaign.CampaignStatus.PARTIALLY_SENT, Campaign.CampaignStatus.NEEDS_REVIEW):
                return _error("Only finished broadcasts with failures can be retried.", "not_retryable", http_status.HTTP_409_CONFLICT)
            retryable = CampaignRecipient.objects.filter(campaign=campaign, status=CampaignRecipient.Status.FAILED).exclude(error_code__in=NON_RETRYABLE_CODES)
            count = retryable.count()
            if count == 0:
                return _error("There are no failed messages that can be retried.", "nothing_to_retry", http_status.HTTP_400_BAD_REQUEST)
            if params.validated_data.get("confirm_recipient_count") != count:
                return _error(f"Please confirm retrying {count} message(s).", "confirmation_required", http_status.HTTP_400_BAD_REQUEST, recipient_count=count)
            retryable.update(status=CampaignRecipient.Status.PENDING, error_code="", error_message="")
            campaign.status = Campaign.CampaignStatus.SCHEDULED
            campaign.completed_at = None
            campaign.save(update_fields=["status", "completed_at"])
            CampaignAuditLog.objects.create(campaign=campaign, action=CampaignAuditLog.Action.RETRY_REQUESTED, user_id=request.user.id, detail={"recipients": count})
        try:
            send_campaign.delay(connection.schema_name, str(campaign.id))
        except Exception:  # noqa: BLE001
            CampaignRecipient.objects.filter(campaign=campaign, status=CampaignRecipient.Status.PENDING).update(
                status=CampaignRecipient.Status.FAILED, error_code="queue_unavailable", error_message="Message queue unavailable."
            )
            Campaign.objects.filter(pk=campaign.pk).update(status=Campaign.CampaignStatus.SENDING)
            finalize_campaign(Campaign.objects.get(pk=campaign.pk))
            return _error("The message queue is unavailable, so nothing was resent.", "queue_unavailable", http_status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response({"detail": "Retry queued.", "recipient_count": count}, status=http_status.HTTP_202_ACCEPTED)

    # ── Resolve unclear outcomes (admin) ────────────────────────────────
    @action(detail=True, methods=["post"], url_path="resolve-unknown", permission_classes=[IsAdminOrAbove])
    def resolve_unknown(self, request, pk=None):
        params = ResolveUnknownSerializer(data=request.data)
        params.is_valid(raise_exception=True)
        campaign = self.get_object()
        qs = CampaignRecipient.objects.filter(campaign=campaign, status=CampaignRecipient.Status.UNKNOWN)
        if params.validated_data.get("recipient_ids"):
            qs = qs.filter(id__in=params.validated_data["recipient_ids"])
        outcome = params.validated_data["outcome"]
        with transaction.atomic():
            if outcome == "sent":
                n = qs.update(status=CampaignRecipient.Status.SENT, error_code="manual_review",
                              error_message="Marked as sent after review.")
            else:
                n = qs.update(status=CampaignRecipient.Status.FAILED, error_code="manual_review",
                              error_message="Marked as not sent after review; can be retried.")
            CampaignAuditLog.objects.create(campaign=campaign, action=CampaignAuditLog.Action.RESOLVED, user_id=request.user.id,
                                            detail={"outcome": outcome, "recipients": n})
            finalize_campaign(campaign)
        return Response({"detail": f"{n} recipient(s) marked as {outcome}.", "updated": n})

    # ── Delivery status lookup ──────────────────────────────────────────
    @action(detail=True, methods=["post"], url_path="refresh-status")
    def refresh_status(self, request, pk=None):
        campaign = self.get_object()
        if campaign.channel != "sms" or campaign.dry_run:
            return _error("Delivery status is only available for real SMS broadcasts.", "not_available", http_status.HTTP_400_BAD_REQUEST)
        unavailable = _sms_unavailable_response()
        if unavailable:
            return unavailable
        try:
            refresh_delivery_status.delay(connection.schema_name, str(campaign.id))
        except Exception:  # noqa: BLE001
            return _error("The message queue is unavailable. Try again shortly.", "queue_unavailable", http_status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response({"detail": "Delivery status check queued."}, status=http_status.HTTP_202_ACCEPTED)

    # ── Per-recipient results & audit trail ─────────────────────────────
    @action(detail=True, methods=["get"])
    def recipients(self, request, pk=None):
        campaign = self.get_object()
        qs = CampaignRecipient.objects.filter(campaign=campaign).order_by("status", "name", "address")
        # One recipient status per param, e.g. ?recipient_status=sent&recipient_status=delivered
        wanted = request.query_params.getlist("recipient_status")
        invalid = [s for s in wanted if s not in CampaignRecipient.Status.values]
        if invalid:
            return Response(
                {"recipient_status": [f"'{s}' is not a valid recipient status." for s in invalid],
                 "valid": list(CampaignRecipient.Status.values)},
                status=http_status.HTTP_400_BAD_REQUEST,
            )
        if wanted:
            qs = qs.filter(status__in=wanted)
        page = self.paginate_queryset(qs)
        ctx = {"show_full_address": getattr(request.user, "role", "") in FULL_ADDRESS_ROLES}
        data = CampaignRecipientSerializer(page, many=True, context=ctx).data
        totals = dict(CampaignRecipient.objects.filter(campaign=campaign).values_list("status").annotate(n=Count("id")))
        response = self.get_paginated_response(data)
        response.data["status_totals"] = totals
        return response

    @action(detail=True, methods=["get"])
    def audit(self, request, pk=None):
        campaign = self.get_object()
        return Response(CampaignAuditLogSerializer(campaign.audit_logs.all()[:200], many=True).data)


class SmsConfigView(APIView):
    """What the UI needs to know about SMS setup. Never includes the API key."""

    permission_classes = [IsStaffOrAbove]

    def get(self, request):
        cfg = get_sms_settings()
        return Response({
            "provider": "AgooSMS",
            "configured": cfg.can_send_real,
            "api_key_configured": cfg.api_key_available,
            "dry_run": cfg.dry_run,
            "sender_ids": list(cfg.sender_ids),
            "default_sender_id": cfg.default_sender_id,
            "large_broadcast_threshold": cfg.large_broadcast_threshold,
            "max_recipients": cfg.max_recipients,
            "max_message_length": cfg.max_message_length,
        })


class SmsConnectionCheckView(APIView):
    """Admin-only: verify the API key with a balance lookup (sends no SMS, costs no credit)."""

    permission_classes = [IsAdminOrAbove]

    def post(self, request):
        from .sms.agoosms import ACCEPTED, AgooSMSClient
        from .sms.config import get_api_key

        cfg = get_sms_settings()
        key = get_api_key()
        if not key:
            return _error("No AgooSMS API key is configured.", "sms_not_configured", http_status.HTTP_503_SERVICE_UNAVAILABLE)
        result = AgooSMSClient(api_key=key, base_url=cfg.base_url, timeout=cfg.timeout).get_balance()
        if result.outcome == ACCEPTED:
            return Response({"ok": True, "detail": "Connected to AgooSMS.", "provider_response": result.response_summary})
        return Response({"ok": False, "detail": result.error_message, "code": result.error_code}, status=http_status.HTTP_502_BAD_GATEWAY)
