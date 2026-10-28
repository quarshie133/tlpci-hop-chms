"""Background sending tests. The SMS client is always a mock or the dry-run client."""

from unittest import mock

from celery.exceptions import Retry
from django.db import connection
from django.test import override_settings
from django_tenants.utils import schema_context

from apps.communications.models import Campaign, CampaignRecipient
from apps.communications.sms.agoosms import (
    ACCEPTED,
    AMBIGUOUS,
    REJECTED,
    RETRYABLE,
    ProviderResult,
    RecipientOutcome,
)
from apps.communications.tasks import send_campaign

from .base import CommsTenantTestCase

BASE = "/api/v1/communications"
NUMBERS = ["+233241234560", "+233241234561", "+233241234562", "+233241234563", "+233241234564"]


class FakeClient:
    """Scripted SMS client: returns the queued results in order and records calls."""

    def __init__(self, *results):
        self.results = list(results)
        self.calls = []
        self.messages = []

    def send(self, to, message, sender_id):
        return self.send_bulk([to], message, sender_id)

    def send_bulk(self, recipients, message, sender_id):
        self.calls.append(list(recipients))
        self.messages.append(message)
        result = self.results.pop(0) if self.results else ProviderResult(ACCEPTED)
        if result.outcome == ACCEPTED:
            for p in recipients:
                result.recipients.setdefault(p, RecipientOutcome(True, f"id-{p[-1]}"))
        return result


class TaskTestCase(CommsTenantTestCase):
    def queue(self, numbers=NUMBERS[:2]):
        campaign = Campaign.objects.create(name="t", channel="sms", body="Hello", sender_id="TLPCI",
                                           status="scheduled", recipient_count=len(numbers))
        CampaignRecipient.objects.bulk_create(CampaignRecipient(campaign=campaign, address=n) for n in numbers)
        return campaign

    def run_task(self, campaign, client=None):
        """Run the task exactly as a worker would: from the public schema."""
        patcher = mock.patch("apps.communications.sms.agoosms.get_sms_client", return_value=client) if client else mock.MagicMock()
        with patcher:
            with schema_context("public"):
                send_campaign.run(self.schema, str(campaign.id))
        connection.set_tenant(self.tenant)
        campaign.refresh_from_db()
        return campaign

    def statuses(self, campaign):
        return dict(campaign.recipient_records.values_list("address", "status"))


class TitleLineTests(TaskTestCase):
    def test_broadcast_name_is_first_line_when_enabled(self):
        campaign = self.queue()
        Campaign.objects.filter(pk=campaign.pk).update(name="Youth Camp", include_name_in_sms=True)
        client = FakeClient()
        self.run_task(campaign, client)
        self.assertEqual(client.messages, ["Youth Camp\nHello"])

    def test_message_unchanged_when_disabled(self):
        client = FakeClient()
        self.run_task(self.queue(), client)
        self.assertEqual(client.messages, ["Hello"])


class DispatchTests(TaskTestCase):
    def test_dry_run_records_simulated_without_provider_calls(self):
        with mock.patch("requests.post") as post:
            campaign = self.run_task(self.queue())
        post.assert_not_called()
        self.assertEqual(campaign.status, "sent")
        self.assertEqual(set(self.statuses(campaign).values()), {"simulated"})
        self.assertEqual(campaign.sent_count, 2)

    def test_accepted_records_provider_ids_and_batches(self):
        client = FakeClient()
        with override_settings(AGOOSMS_MAX_BULK=2):
            campaign = self.run_task(self.queue(NUMBERS), client)
        self.assertEqual([len(c) for c in client.calls], [2, 2, 1])
        self.assertEqual(campaign.status, "sent")
        self.assertEqual(campaign.sent_count, 5)
        rec = campaign.recipient_records.get(address=NUMBERS[0])
        self.assertEqual((rec.status, rec.provider_message_id, rec.attempts), ("sent", "id-0", 1))

    def test_partial_failure_from_itemised_response(self):
        result = ProviderResult(ACCEPTED, recipients={NUMBERS[1]: RecipientOutcome(False, error="Invalid number")})
        campaign = self.run_task(self.queue(), FakeClient(result))
        self.assertEqual(campaign.status, "partially_sent")
        self.assertEqual((campaign.sent_count, campaign.failed_count), (1, 1))
        self.assertEqual(campaign.recipient_records.get(address=NUMBERS[1]).error_message, "Invalid number")

    def test_ambiguous_timeout_flags_for_review_and_is_never_resent(self):
        client = FakeClient(ProviderResult(AMBIGUOUS, error_code="timeout", error_message="no response"))
        campaign = self.run_task(self.queue(), client)
        self.assertEqual(campaign.status, "needs_review")
        self.assertEqual(campaign.unknown_count, 2)
        self.assertEqual(len(client.calls), 1)
        # A redelivered task does nothing.
        Campaign.objects.filter(id=campaign.id).update(status="sending")
        again = FakeClient()
        self.run_task(campaign, again)
        self.assertEqual(again.calls, [])

    def test_auth_failure_stops_and_fails_everything(self):
        client = FakeClient(ProviderResult(REJECTED, 401, "auth", "bad key"))
        with override_settings(AGOOSMS_MAX_BULK=2):
            campaign = self.run_task(self.queue(NUMBERS), client)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(campaign.status, "failed")
        self.assertEqual(campaign.failed_count, 5)
        self.assertEqual(set(campaign.recipient_records.values_list("error_code", flat=True)), {"auth"})

    def test_rate_limit_retries_without_marking_sent(self):
        client = FakeClient(ProviderResult(RETRYABLE, 429, "rate_limited", "slow down", retry_after=5))
        campaign = self.queue()
        with self.assertRaises(Retry):
            self.run_task(campaign, client)
        connection.set_tenant(self.tenant)
        self.assertEqual(set(self.statuses(campaign).values()), {"pending"})
        campaign.refresh_from_db()
        self.assertEqual(campaign.status, "sending")

    def test_interrupted_rows_become_unknown_not_resent(self):
        campaign = self.queue()
        CampaignRecipient.objects.filter(address=NUMBERS[0]).update(status="sending")
        Campaign.objects.filter(id=campaign.id).update(status="sending")
        client = FakeClient()
        campaign = self.run_task(campaign, client)
        self.assertEqual(client.calls, [[NUMBERS[1]]])
        self.assertEqual(self.statuses(campaign)[NUMBERS[0]], "unknown")
        self.assertEqual(campaign.status, "needs_review")

    def test_completed_campaign_is_not_reprocessed(self):
        campaign = self.run_task(self.queue(), FakeClient())
        again = FakeClient()
        self.run_task(campaign, again)
        self.assertEqual(again.calls, [])

    @override_settings(SMS_DRY_RUN=False, AGOOSMS_API_KEY="")
    def test_missing_configuration_fails_cleanly(self):
        campaign = self.run_task(self.queue())
        self.assertEqual(campaign.status, "failed")
        self.assertEqual(set(campaign.recipient_records.values_list("error_code", flat=True)), {"not_configured"})


class RetryAndResolveApiTests(TaskTestCase):
    def setUp(self):
        super().setUp()
        self.delay = mock.patch("apps.communications.views.send_campaign.delay").start()
        self.addCleanup(mock.patch.stopall)

    def finished_with_mixed_outcomes(self):
        campaign = self.queue(NUMBERS[:4])
        S = CampaignRecipient.Status
        updates = {NUMBERS[0]: (S.SENT, ""), NUMBERS[1]: (S.FAILED, "network"), NUMBERS[2]: (S.FAILED, "validation"), NUMBERS[3]: (S.UNKNOWN, "timeout")}
        for number, (status, code) in updates.items():
            CampaignRecipient.objects.filter(campaign=campaign, address=number).update(status=status, error_code=code)
        Campaign.objects.filter(id=campaign.id).update(status="needs_review")
        return campaign

    def test_retry_only_resets_retryable_failures(self):
        campaign = self.finished_with_mixed_outcomes()
        api = self.client_for(self.staff)
        need_confirm = api.post(f"{BASE}/campaigns/{campaign.id}/retry-failed/", {}, format="json")
        self.assertEqual((need_confirm.status_code, need_confirm.data["recipient_count"]), (400, 1))
        resp = api.post(f"{BASE}/campaigns/{campaign.id}/retry-failed/", {"confirm_recipient_count": 1}, format="json")
        self.assertEqual(resp.status_code, 202)
        self.delay.assert_called_once()
        s = self.statuses(campaign)
        self.assertEqual((s[NUMBERS[0]], s[NUMBERS[1]], s[NUMBERS[2]], s[NUMBERS[3]]), ("sent", "pending", "failed", "unknown"))

    def test_admin_resolves_unknown_as_failed_then_finalises(self):
        campaign = self.finished_with_mixed_outcomes()
        resp = self.client_for(self.admin).post(f"{BASE}/campaigns/{campaign.id}/resolve-unknown/", {"outcome": "failed"}, format="json")
        self.assertEqual((resp.status_code, resp.data["updated"]), (200, 1))
        campaign.refresh_from_db()
        self.assertEqual(campaign.status, "partially_sent")
        self.assertEqual((campaign.sent_count, campaign.failed_count, campaign.unknown_count), (1, 3, 0))
        self.assertTrue(campaign.audit_logs.filter(action="resolved", user_id=self.admin.id).exists())


class DeliveryStatusTests(TaskTestCase):
    """GET /v1/sms/:id/status — AgooSMS reports per batch (one id for a bulk send)."""

    def accepted_batch(self, numbers, message_id="batch-1"):
        campaign = self.queue(numbers)
        CampaignRecipient.objects.filter(campaign=campaign).update(status="sent", provider_message_id=message_id)
        Campaign.objects.filter(id=campaign.id).update(status="sent", sent_count=len(numbers))
        return campaign

    def refresh(self, campaign, body):
        import json

        from apps.communications.tasks import refresh_delivery_status

        client = mock.Mock()
        client.get_status.return_value = ProviderResult(ACCEPTED, 200, response_summary=json.dumps(body))
        with mock.patch("apps.communications.sms.agoosms.get_sms_client", return_value=client):
            refresh_delivery_status.run(self.schema, str(campaign.id))
        connection.set_tenant(self.tenant)
        campaign.refresh_from_db()
        return client

    def report(self, delivered, failed, total=3, status="COMPLETED"):
        return {"success": True, "data": {"messageId": "batch-1", "status": status, "testMode": False,
                                          "recipientCount": total, "deliveredCount": delivered, "failedCount": failed}}

    def test_all_delivered_marks_each_recipient_delivered_with_one_lookup(self):
        campaign = self.accepted_batch(NUMBERS[:3])
        client = self.refresh(campaign, self.report(3, 0))
        client.get_status.assert_called_once_with("batch-1")
        self.assertEqual(set(self.statuses(campaign).values()), {"delivered"})
        self.assertEqual(set(campaign.recipient_records.values_list("delivery_status", flat=True)), {"COMPLETED (3/3 delivered)"})
        self.assertEqual((campaign.status, campaign.sent_count), ("sent", 3))

    def test_all_failed_marks_each_recipient_failed(self):
        campaign = self.accepted_batch(NUMBERS[:3])
        self.refresh(campaign, self.report(0, 3))
        self.assertEqual(set(self.statuses(campaign).values()), {"failed"})
        self.assertEqual(campaign.status, "failed")

    def test_mixed_batch_keeps_accepted_and_records_counts(self):
        campaign = self.accepted_batch(NUMBERS[:3])
        self.refresh(campaign, self.report(2, 1))
        self.assertEqual(set(self.statuses(campaign).values()), {"sent"})
        self.assertEqual(set(campaign.recipient_records.values_list("delivery_status", flat=True)), {"COMPLETED (2/3 delivered)"})

    def test_in_progress_batch_is_unchanged(self):
        campaign = self.accepted_batch(NUMBERS[:2])
        self.refresh(campaign, self.report(0, 0, total=2, status="PROCESSING"))
        self.assertEqual(set(self.statuses(campaign).values()), {"sent"})

    def test_per_message_status_without_counts(self):
        campaign = self.accepted_batch(NUMBERS[:1])
        self.refresh(campaign, {"success": True, "data": {"status": "DELIVERED"}})
        self.assertEqual(set(self.statuses(campaign).values()), {"delivered"})
