"""Campaign API tests (tenant-scoped). Celery dispatch is mocked; no SMS is sent."""

from unittest import mock

from django.test import override_settings

from apps.communications.models import Campaign, CampaignAuditLog, CampaignRecipient

from .base import CommsTenantTestCase

BASE = "/api/v1/communications"


class CampaignApiTestCase(CommsTenantTestCase):
    def setUp(self):
        super().setUp()
        self.delay = mock.patch("apps.communications.views.send_campaign.delay").start()
        self.addCleanup(mock.patch.stopall)
        self.api = self.client_for(self.staff)

    def create_draft(self, **overrides):
        payload = {"name": "Sunday reminder", "channel": "sms", "body": "Service starts at 9am.", "recipients_filter": {"type": "active"}}
        payload.update(overrides)
        resp = self.api.post(f"{BASE}/campaigns/", payload, format="json")
        self.assertEqual(resp.status_code, 201, resp.data)
        return resp.data


class PermissionTests(CampaignApiTestCase):
    def test_unauthenticated_rejected(self):
        resp = self.client_for().get(f"{BASE}/campaigns/")
        self.assertEqual(resp.status_code, 401)

    def test_member_role_cannot_list_create_or_send(self):
        draft = self.create_draft()
        member = self.client_for(self.member_user)
        self.assertEqual(member.get(f"{BASE}/campaigns/").status_code, 403)
        self.assertEqual(member.post(f"{BASE}/campaigns/", {"name": "x"}, format="json").status_code, 403)
        self.assertEqual(member.post(f"{BASE}/campaigns/{draft['id']}/send/", {}, format="json").status_code, 403)
        self.assertEqual(member.get(f"{BASE}/sms/config/").status_code, 403)
        self.delay.assert_not_called()

    def test_resolve_unknown_and_connection_check_are_admin_only(self):
        draft = self.create_draft()
        self.assertEqual(self.api.post(f"{BASE}/campaigns/{draft['id']}/resolve-unknown/", {"outcome": "failed"}, format="json").status_code, 403)
        self.assertEqual(self.api.post(f"{BASE}/sms/check-connection/").status_code, 403)

    def test_config_never_exposes_key(self):
        with override_settings(AGOOSMS_API_KEY="super-secret-key"):
            resp = self.api.get(f"{BASE}/sms/config/")
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("super-secret-key", resp.content.decode())
        self.assertTrue(resp.data["api_key_configured"])
        self.assertEqual(resp.data["sender_ids"], ["TLPCI"])


class ValidationTests(CampaignApiTestCase):
    def test_empty_message_rejected(self):
        resp = self.api.post(f"{BASE}/campaigns/", {"name": "x", "channel": "sms", "body": "   "}, format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("body", resp.data)

    def test_raw_orm_filters_are_rejected(self):
        resp = self.api.post(f"{BASE}/campaigns/", {"name": "x", "channel": "sms", "body": "hi",
                                                    "recipients_filter": {"contributions__amount__gt": 0}}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_legacy_filter_is_mapped(self):
        data = self.create_draft(recipients_filter={"status": "visitor"})
        self.assertEqual(data["recipients_filter"], {"type": "visitors"})

    def test_unapproved_sender_id_rejected(self):
        resp = self.api.post(f"{BASE}/campaigns/", {"name": "x", "channel": "sms", "body": "hi", "sender_id": "SPOOF"}, format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("sender_id", resp.data)

    def test_default_sender_id_applied(self):
        self.assertEqual(self.create_draft()["sender_id"], "TLPCI")

    def test_invalid_single_phone_rejected(self):
        resp = self.api.post(f"{BASE}/campaigns/", {"name": "x", "channel": "sms", "body": "hi",
                                                    "recipients_filter": {"type": "phone", "phone": "555-1234"}}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_message_length_limit(self):
        with override_settings(SMS_MAX_MESSAGE_LENGTH=10):
            resp = self.api.post(f"{BASE}/campaigns/", {"name": "x", "channel": "sms", "body": "x" * 11}, format="json")
        self.assertEqual(resp.status_code, 400)


class PreviewTests(CampaignApiTestCase):
    def test_counts_valid_invalid_missing_and_duplicates(self):
        self.make_member("Ama", "Mensah", phone="0241234567")
        self.make_member("Kofi", "Mensah", phone="+233 24 123 4567")  # same household phone
        self.make_member("Yaw", "Boateng", phone="(555) 234-8901")  # not Ghana
        self.make_member("Esi", "Owusu")  # no phone
        self.make_member("Visitor", "One", phone="0201112222", status="visitor")
        resp = self.api.post(f"{BASE}/campaigns/preview/", {"channel": "sms", "recipients_filter": {"type": "active"}, "body": "Hello"}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["matched"], 4)
        self.assertEqual(resp.data["recipients"], 1)
        self.assertEqual(resp.data["duplicates_removed"], 1)
        self.assertEqual(resp.data["invalid"], 1)
        self.assertEqual(resp.data["missing_contact"], 1)
        self.assertEqual(resp.data["invalid_sample"][0]["name"], "Yaw Boateng")
        self.assertEqual(resp.data["segments_per_message"], 1)

    def test_title_line_counts_toward_segments(self):
        self.make_member("Ama", "Mensah", phone="0241234567")
        payload = {"channel": "sms", "recipients_filter": {"type": "active"}, "body": "x" * 150, "name": "Youth Camp"}
        plain = self.api.post(f"{BASE}/campaigns/preview/", payload, format="json")
        titled = self.api.post(f"{BASE}/campaigns/preview/", {**payload, "include_name_in_sms": True}, format="json")
        self.assertEqual((plain.data["characters"], plain.data["segments_per_message"]), (150, 1))
        self.assertEqual((titled.data["characters"], titled.data["segments_per_message"]), (161, 2))

    def test_selected_members_audience(self):
        a = self.make_member("A", "One", phone="0241234567")
        self.make_member("B", "Two", phone="0201112222")
        resp = self.api.post(f"{BASE}/campaigns/preview/", {"channel": "sms", "recipients_filter": {"type": "members", "member_ids": [str(a.id)]}}, format="json")
        self.assertEqual(resp.data["recipients"], 1)


class SendTests(CampaignApiTestCase):
    def test_send_queues_once_and_records_recipients(self):
        self.make_member("Ama", "Mensah", phone="0241234567")
        self.make_member("Esi", "Owusu")
        draft = self.create_draft()
        resp = self.api.post(f"{BASE}/campaigns/{draft['id']}/send/", {}, format="json")
        self.assertEqual(resp.status_code, 202, resp.data)
        self.assertTrue(resp.data["dry_run"])
        self.delay.assert_called_once_with(self.schema, draft["id"])

        campaign = Campaign.objects.get(id=draft["id"])
        self.assertEqual(campaign.status, "scheduled")
        self.assertEqual((campaign.recipient_count, campaign.skipped_count), (1, 1))
        self.assertEqual(campaign.sent_by_user_id, self.staff.id)
        self.assertEqual(
            sorted(CampaignRecipient.objects.filter(campaign=campaign).values_list("status", "address")),
            [("pending", "+233241234567"), ("skipped", f"skipped:{campaign.recipient_records.get(status='skipped').member_id}")],
        )
        self.assertTrue(CampaignAuditLog.objects.filter(campaign=campaign, action="queued", user_id=self.staff.id).exists())

        # Double-click / replay: second send is refused and nothing is queued again.
        again = self.api.post(f"{BASE}/campaigns/{draft['id']}/send/", {}, format="json")
        self.assertEqual(again.status_code, 409)
        self.assertEqual(self.delay.call_count, 1)

    def test_large_broadcast_requires_matching_confirmation(self):
        for i in range(3):
            self.make_member(f"P{i}", "X", phone=f"024123456{i}")
        draft = self.create_draft()
        resp = self.api.post(f"{BASE}/campaigns/{draft['id']}/send/", {}, format="json")
        self.assertEqual((resp.status_code, resp.data["code"], resp.data["recipient_count"]), (400, "confirmation_required", 3))
        wrong = self.api.post(f"{BASE}/campaigns/{draft['id']}/send/", {"confirm_recipient_count": 2}, format="json")
        self.assertEqual(wrong.status_code, 400)
        self.delay.assert_not_called()
        self.assertEqual(Campaign.objects.get(id=draft["id"]).status, "draft")
        ok = self.api.post(f"{BASE}/campaigns/{draft['id']}/send/", {"confirm_recipient_count": 3}, format="json")
        self.assertEqual(ok.status_code, 202)

    def test_no_valid_recipients(self):
        self.make_member("No", "Phone")
        draft = self.create_draft()
        resp = self.api.post(f"{BASE}/campaigns/{draft['id']}/send/", {}, format="json")
        self.assertEqual((resp.status_code, resp.data["code"]), (400, "no_recipients"))

    @override_settings(SMS_DRY_RUN=False, AGOOSMS_API_KEY="")
    def test_missing_api_key_gives_clear_503(self):
        self.make_member("Ama", "Mensah", phone="0241234567")
        draft = self.create_draft()
        resp = self.api.post(f"{BASE}/campaigns/{draft['id']}/send/", {}, format="json")
        self.assertEqual((resp.status_code, resp.data["code"]), (503, "sms_not_configured"))
        self.assertIn("API key", resp.data["detail"])
        self.delay.assert_not_called()

    def test_broker_down_rolls_back_to_draft(self):
        self.make_member("Ama", "Mensah", phone="0241234567")
        draft = self.create_draft()
        self.delay.side_effect = ConnectionError("redis down")
        resp = self.api.post(f"{BASE}/campaigns/{draft['id']}/send/", {}, format="json")
        self.assertEqual((resp.status_code, resp.data["code"]), (503, "queue_unavailable"))
        campaign = Campaign.objects.get(id=draft["id"])
        self.assertEqual(campaign.status, "draft")
        self.assertFalse(campaign.dry_run)
        self.assertIsNone(campaign.sent_by_user_id)
        self.assertFalse(campaign.recipient_records.exists())

    def test_single_phone_audience(self):
        draft = self.create_draft(recipients_filter={"type": "phone", "phone": "0241234567", "name": "Guest"})
        resp = self.api.post(f"{BASE}/campaigns/{draft['id']}/send/", {}, format="json")
        self.assertEqual(resp.status_code, 202)
        self.assertEqual(Campaign.objects.get(id=draft["id"]).recipient_records.get().address, "+233241234567")


class HistoryProtectionTests(CampaignApiTestCase):
    def queued(self):
        self.make_member("Ama", "Mensah", phone="0241234567")
        draft = self.create_draft()
        self.api.post(f"{BASE}/campaigns/{draft['id']}/send/", {}, format="json")
        return draft["id"]

    def test_queued_campaign_cannot_be_edited_or_deleted(self):
        cid = self.queued()
        self.assertEqual(self.api.patch(f"{BASE}/campaigns/{cid}/", {"body": "changed"}, format="json").status_code, 400)
        admin = self.client_for(self.admin)
        resp = admin.delete(f"{BASE}/campaigns/{cid}/")
        self.assertEqual((resp.status_code, resp.data["code"]), (409, "in_progress"))
        Campaign.objects.filter(id=cid).update(status="sending")
        self.assertEqual(admin.delete(f"{BASE}/campaigns/{cid}/").status_code, 409)
        self.assertTrue(Campaign.objects.filter(id=cid).exists())

    def test_staff_can_delete_drafts(self):
        draft = self.create_draft()
        self.assertEqual(self.api.delete(f"{BASE}/campaigns/{draft['id']}/").status_code, 204)
        self.assertFalse(Campaign.objects.filter(id=draft["id"]).exists())

    def test_staff_cannot_delete_finished_broadcasts(self):
        cid = self.queued()
        Campaign.objects.filter(id=cid).update(status="failed")
        resp = self.api.delete(f"{BASE}/campaigns/{cid}/")
        self.assertEqual((resp.status_code, resp.data["code"]), (403, "admin_required"))
        self.assertTrue(Campaign.objects.filter(id=cid).exists())

    def test_admin_can_delete_finished_broadcasts_with_their_records(self):
        for final_status in ("failed", "sent", "partially_sent", "needs_review"):
            with self.subTest(status=final_status):
                CampaignRecipient.objects.all().delete()
                Campaign.objects.all().delete()
                cid = self.queued()
                Campaign.objects.filter(id=cid).update(status=final_status)
                resp = self.client_for(self.admin).delete(f"{BASE}/campaigns/{cid}/")
                self.assertEqual(resp.status_code, 204)
                self.assertFalse(Campaign.objects.filter(id=cid).exists())
                self.assertFalse(CampaignRecipient.objects.filter(campaign_id=cid).exists())
                self.assertFalse(CampaignAuditLog.objects.filter(campaign_id=cid).exists())

    def test_recipient_numbers_masked_for_staff_full_for_admin(self):
        cid = self.queued()
        staff_view = self.api.get(f"{BASE}/campaigns/{cid}/recipients/")
        self.assertEqual(staff_view.status_code, 200)
        self.assertEqual(staff_view.data["results"][0]["address"], "+233 24 *** 4567")
        admin_view = self.client_for(self.admin).get(f"{BASE}/campaigns/{cid}/recipients/")
        self.assertEqual(admin_view.data["results"][0]["address"], "+233241234567")
        self.assertEqual(staff_view.data["status_totals"], {"pending": 1})

    def test_audit_trail(self):
        cid = self.queued()
        actions = [row["action"] for row in self.api.get(f"{BASE}/campaigns/{cid}/audit/").data]
        self.assertEqual(actions, ["queued", "created"])
