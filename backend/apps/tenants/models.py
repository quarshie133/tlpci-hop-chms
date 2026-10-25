"""
Tenants app models.
Church (Tenant) and Domain follow django-tenants conventions.
"""

from django.db import models
from django_tenants.models import DomainMixin, TenantMixin


class Church(TenantMixin):
    """One row per church in the public schema."""

    name = models.CharField(max_length=200)
    slug = models.SlugField(unique=True)
    description = models.TextField(blank=True)
    address = models.TextField(blank=True)
    city = models.CharField(max_length=100, blank=True)
    state = models.CharField(max_length=100, blank=True)
    country = models.CharField(max_length=100, default="US")
    postal_code = models.CharField(max_length=20, blank=True)
    phone = models.CharField(max_length=30, blank=True)
    email = models.EmailField(blank=True)
    website = models.URLField(blank=True)
    logo = models.ImageField(upload_to="church_logos/", null=True, blank=True)
    denomination = models.CharField(max_length=100, blank=True)
    founded_year = models.PositiveSmallIntegerField(null=True, blank=True)
    timezone = models.CharField(max_length=50, default="America/New_York")
    currency = models.CharField(max_length=3, default="GHS")
    is_active = models.BooleanField(default=True)
    subscription_plan = models.CharField(
        max_length=20,
        choices=[("free", "Free"), ("basic", "Basic"), ("pro", "Pro"), ("enterprise", "Enterprise")],
        default="free",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # django-tenants required
    auto_create_schema = True

    class Meta:
        app_label = "tenants"

    def __str__(self):
        return self.name


class Domain(DomainMixin):
    """Maps subdomains/custom domains to a Church tenant."""

    class Meta:
        app_label = "tenants"
