"""Communications serializers."""

from rest_framework import serializers

from .audience import describe_audience, validate_audience
from .models import Campaign, CampaignAuditLog, CampaignRecipient, MessageTemplate, compose_sms
from .sms.config import get_sms_settings
from .sms.phone import mask_phone


class MessageTemplateSerializer(serializers.ModelSerializer):
    class Meta:
        model = MessageTemplate
        fields = "__all__"
        read_only_fields = ["id", "created_at"]


class CampaignSerializer(serializers.ModelSerializer):
    audience_label = serializers.SerializerMethodField()

    class Meta:
        model = Campaign
        fields = [
            "id", "name", "channel", "subject", "body", "sender_id", "include_name_in_sms", "recipients_filter", "audience_label",
            "recipient_count", "sent_count", "failed_count", "unknown_count", "skipped_count",
            "status", "dry_run", "last_error", "scheduled_at", "processing_started_at", "sent_at",
            "completed_at", "created_by_user_id", "sent_by_user_id", "created_at", "template",
        ]
        read_only_fields = [
            "id", "recipient_count", "sent_count", "failed_count", "unknown_count", "skipped_count",
            "status", "dry_run", "last_error", "scheduled_at", "processing_started_at", "sent_at",
            "completed_at", "created_by_user_id", "sent_by_user_id", "created_at", "audience_label",
        ]

    def get_audience_label(self, obj) -> str:
        return describe_audience(obj.recipients_filter or {})

    def validate(self, attrs):
        channel = attrs.get("channel") or getattr(self.instance, "channel", None)
        body = attrs.get("body", getattr(self.instance, "body", ""))
        if not (body or "").strip():
            raise serializers.ValidationError({"body": "Message can't be empty."})
        if "recipients_filter" in attrs or self.instance is None:
            attrs["recipients_filter"] = validate_audience(attrs.get("recipients_filter") or {"type": "active"}, channel)

        if channel == "sms":
            cfg = get_sms_settings()
            text = compose_sms(
                attrs.get("name", getattr(self.instance, "name", "")),
                body,
                attrs.get("include_name_in_sms", getattr(self.instance, "include_name_in_sms", False)),
            )
            if len(text) > cfg.max_message_length:
                raise serializers.ValidationError(
                    {"body": f"SMS messages are limited to {cfg.max_message_length} characters, including the title line."}
                )
            sender = (attrs.get("sender_id", getattr(self.instance, "sender_id", "")) or "").strip()
            if sender and cfg.sender_ids and sender not in cfg.sender_ids:
                raise serializers.ValidationError({"sender_id": "Choose one of the approved sender IDs."})
            attrs["sender_id"] = sender or cfg.default_sender_id
        elif channel == "email":
            subject = attrs.get("subject", getattr(self.instance, "subject", ""))
            if not (subject or "").strip():
                raise serializers.ValidationError({"subject": "Email broadcasts need a subject."})
            attrs["sender_id"] = ""
        return attrs


class CampaignRecipientSerializer(serializers.ModelSerializer):
    address = serializers.SerializerMethodField()

    class Meta:
        model = CampaignRecipient
        fields = [
            "id", "member_id", "name", "address", "status", "provider_message_id", "delivery_status",
            "error_code", "error_message", "attempts", "sent_at", "updated_at",
        ]

    def get_address(self, obj) -> str:
        # Full numbers/emails only for administrators and pastors.
        if self.context.get("show_full_address"):
            return obj.address
        if "@" in obj.address:
            local, _, domain = obj.address.partition("@")
            return f"{local[:1]}***@{domain}"
        return mask_phone(obj.address)


class CampaignAuditLogSerializer(serializers.ModelSerializer):
    class Meta:
        model = CampaignAuditLog
        fields = ["id", "action", "user_id", "detail", "created_at"]


class AudiencePreviewSerializer(serializers.Serializer):
    channel = serializers.ChoiceField(choices=["sms", "email"])
    recipients_filter = serializers.JSONField()
    body = serializers.CharField(required=False, allow_blank=True, default="")
    name = serializers.CharField(required=False, allow_blank=True, default="")
    include_name_in_sms = serializers.BooleanField(required=False, default=False)

    def validate(self, attrs):
        attrs["recipients_filter"] = validate_audience(attrs["recipients_filter"], attrs["channel"])
        return attrs


class SendCampaignSerializer(serializers.Serializer):
    confirm_recipient_count = serializers.IntegerField(required=False, min_value=0)


class ResolveUnknownSerializer(serializers.Serializer):
    outcome = serializers.ChoiceField(choices=["sent", "failed"])
    recipient_ids = serializers.ListField(child=serializers.UUIDField(), required=False, allow_empty=False)
