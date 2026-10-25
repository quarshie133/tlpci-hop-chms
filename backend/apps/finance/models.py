"""Finance models: Tithes, Offerings, Pledges, Funds, Giving Statements."""

import uuid
from django.db import models
from apps.members.models import Member


class Fund(models.Model):
    """A designated fund (e.g. General, Building, Missions)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    goal_amount = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class Contribution(models.Model):
    """A single financial contribution (tithe, offering, donation)."""

    class ContributionType(models.TextChoices):
        TITHE = "tithe", "Tithe"
        OFFERING = "offering", "Offering"
        DONATION = "donation", "Donation"
        PLEDGE_PAYMENT = "pledge_payment", "Pledge Payment"
        BUILDING = "building", "Building Fund"
        MISSIONS = "missions", "Missions"
        OTHER = "other", "Other"

    class PaymentMethod(models.TextChoices):
        CASH = "cash", "Cash"
        CHECK = "check", "Check"
        CARD = "card", "Card"
        BANK_TRANSFER = "bank_transfer", "Bank Transfer"
        ONLINE = "online", "Online"
        MOBILE_MONEY = "mobile_money", "Mobile Money"
        OTHER = "other", "Other"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    member = models.ForeignKey(Member, on_delete=models.SET_NULL, null=True, blank=True, related_name="contributions")
    fund = models.ForeignKey(Fund, on_delete=models.PROTECT, related_name="contributions")
    contribution_type = models.CharField(max_length=30, choices=ContributionType.choices, default=ContributionType.TITHE)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.CharField(max_length=3, default="GHS")
    payment_method = models.CharField(max_length=30, choices=PaymentMethod.choices, default=PaymentMethod.CASH)
    reference_number = models.CharField(max_length=100, blank=True)
    check_number = models.CharField(max_length=50, blank=True)
    date = models.DateField()
    is_anonymous = models.BooleanField(default=False)
    notes = models.TextField(blank=True)
    created_by_user_id = models.BigIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-date"]

    def __str__(self):
        return f"{self.amount} — {self.member or 'Anonymous'} ({self.date})"


class Pledge(models.Model):
    """A member's financial pledge over a period."""

    class PledgeStatus(models.TextChoices):
        ACTIVE = "active", "Active"
        FULFILLED = "fulfilled", "Fulfilled"
        CANCELLED = "cancelled", "Cancelled"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    member = models.ForeignKey(Member, on_delete=models.CASCADE, related_name="pledges")
    fund = models.ForeignKey(Fund, on_delete=models.PROTECT, related_name="pledges")
    total_amount = models.DecimalField(max_digits=14, decimal_places=2)
    paid_amount = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    start_date = models.DateField()
    end_date = models.DateField()
    status = models.CharField(max_length=20, choices=PledgeStatus.choices, default=PledgeStatus.ACTIVE)
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-start_date"]

    @property
    def remaining_amount(self):
        return self.total_amount - self.paid_amount

    @property
    def fulfillment_pct(self):
        if self.total_amount:
            return round(float(self.paid_amount) / float(self.total_amount) * 100, 1)
        return 0
