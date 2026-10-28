"""Communications models: Email campaigns, SMS blasts, Templates."""

import uuid
from django.db import models


class MessageTemplate(models.Model):
    class ChannelType(models.TextChoices):
        EMAIL = "email", "Email"
        SMS = "sms", "SMS"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    channel = models.CharField(max_length=10, choices=ChannelType.choices)
    subject = models.CharField(max_length=300, blank=True)  # email only
    body = models.TextField()
    variables = models.JSONField(default=list, blank=True, help_text="List of variable names in template")
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"[{self.channel.upper()}] {self.name}"


class Campaign(models.Model):
    class CampaignStatus(models.TextChoices):
        DRAFT = "draft", "Draft"
        SCHEDULED = "scheduled", "Queued"
        SENDING = "sending", "Sending"
        SENT = "sent", "Sent"
        PARTIALLY_SENT = "partially_sent", "Partially sent"
        NEEDS_REVIEW = "needs_review", "Needs review"
        FAILED = "failed", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=300)
    template = models.ForeignKey(MessageTemplate, on_delete=models.SET_NULL, null=True, blank=True)
    channel = models.CharField(max_length=10, choices=MessageTemplate.ChannelType.choices)
    subject = models.CharField(max_length=300, blank=True)
    body = models.TextField()
    sender_id = models.CharField(max_length=11, blank=True, help_text="Approved SMS sender ID used for this campaign")
    include_name_in_sms = models.BooleanField(
        default=False, help_text="Put the broadcast name on the first line of the SMS (SMS has no subject field)"
    )
    recipients_filter = models.JSONField(default=dict, blank=True, help_text="Validated audience specification")
    recipient_count = models.PositiveIntegerField(default=0)
    sent_count = models.PositiveIntegerField(default=0)
    failed_count = models.PositiveIntegerField(default=0)
    unknown_count = models.PositiveIntegerField(default=0, help_text="Outcome unclear (e.g. provider timeout); needs review")
    skipped_count = models.PositiveIntegerField(default=0, help_text="No valid phone/email; never sent")
    status = models.CharField(max_length=20, choices=CampaignStatus.choices, default=CampaignStatus.DRAFT)
    dry_run = models.BooleanField(default=False, help_text="Processed in test mode; no real messages were sent")
    last_error = models.CharField(max_length=500, blank=True)
    scheduled_at = models.DateTimeField(null=True, blank=True)
    processing_started_at = models.DateTimeField(null=True, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    created_by_user_id = models.BigIntegerField(null=True, blank=True)
    sent_by_user_id = models.BigIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.name} ({self.status})"

    @property
    def sms_text(self) -> str:
        """The exact text recipients receive."""
        return compose_sms(self.name, self.body, self.include_name_in_sms)


def compose_sms(name: str, body: str, include_name: bool) -> str:
    """SMS has no title field, so the broadcast name, when wanted, becomes the first line."""
    name = (name or "").strip()
    return f"{name}\n{body}" if include_name and name else body


class CampaignRecipient(models.Model):
    """Individual delivery record per recipient."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        SENDING = "sending", "Sending"
        SENT = "sent", "Accepted by provider"
        DELIVERED = "delivered", "Delivered"
        FAILED = "failed", "Failed"
        UNKNOWN = "unknown", "Unknown — needs review"
        SKIPPED = "skipped", "Skipped"
        SIMULATED = "simulated", "Simulated (test mode)"
        BOUNCED = "bounced", "Bounced"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    campaign = models.ForeignKey(Campaign, on_delete=models.CASCADE, related_name="recipient_records")
    member_id = models.UUIDField(null=True, blank=True)
    name = models.CharField(max_length=200, blank=True)
    address = models.CharField(max_length=300)  # email or E.164 phone
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    provider_message_id = models.CharField(max_length=120, blank=True, db_index=True)
    delivery_status = models.CharField(max_length=40, blank=True, help_text="Raw status from the provider's status lookup")
    error_code = models.CharField(max_length=40, blank=True)
    error_message = models.TextField(blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    sent_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True, null=True)

    class Meta:
        ordering = ["-sent_at"]
        constraints = [
            # One row per destination per campaign: prevents duplicate sends to the same number/email.
            models.UniqueConstraint(fields=["campaign", "address"], name="uniq_campaign_recipient_address"),
        ]


class CampaignAuditLog(models.Model):
    """Who did what to a campaign, and when."""

    class Action(models.TextChoices):
        CREATED = "created", "Created"
        UPDATED = "updated", "Updated"
        QUEUED = "queued", "Queued for sending"
        QUEUE_FAILED = "queue_failed", "Could not queue"
        PROCESSING = "processing", "Processing started"
        COMPLETED = "completed", "Processing completed"
        RETRY_REQUESTED = "retry_requested", "Retry of failed recipients requested"
        RESOLVED = "resolved", "Unclear outcomes resolved"
        STATUS_REFRESH = "status_refresh", "Delivery status refreshed"

    id = models.BigAutoField(primary_key=True)
    campaign = models.ForeignKey(Campaign, on_delete=models.CASCADE, related_name="audit_logs")
    action = models.CharField(max_length=30, choices=Action.choices)
    user_id = models.BigIntegerField(null=True, blank=True)
    detail = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
