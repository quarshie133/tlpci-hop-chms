"""
Django settings for ChurchMS backend.
Environment-driven configuration via .env file.
"""

import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Base
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "change-me-in-production")
DEBUG = os.environ.get("DEBUG", "True") == "True"



def _env_list(name, default):
    """Comma-separated env value as a list, ignoring blanks and stray spaces."""
    return [v.strip() for v in os.environ.get(name, default).split(",") if v.strip()]


def _bare_host(value):
    """'https://example.com/' -> 'example.com'. ALLOWED_HOSTS takes hostnames, not URLs."""
    return value.split("://", 1)[-1].split("/", 1)[0]


ALLOWED_HOSTS = [_bare_host(h) for h in _env_list("ALLOWED_HOSTS", "localhost,127.0.0.1")]
# Render sets this to the service's own hostname (e.g. myapp.onrender.com).
if os.environ.get("RENDER_EXTERNAL_HOSTNAME"):
    ALLOWED_HOSTS.append(os.environ["RENDER_EXTERNAL_HOSTNAME"])

# ---------------------------------------------------------------------------
# Multi-tenancy (django-tenants)
# ---------------------------------------------------------------------------
SHARED_APPS = [
    "django_tenants",
    "apps.tenants",   # Tenant model lives here
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.admin",
    # Shared third-party
    "rest_framework",
    "rest_framework_simplejwt",
    "rest_framework_simplejwt.token_blacklist",
    "corsheaders",
    "django_filters",
    "drf_spectacular",
    "django_celery_beat",
    "django_celery_results",
    "phonenumber_field",
    # Shared app
    "apps.accounts",
]

TENANT_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
    # Tenant-specific apps
    "apps.members",
    "apps.attendance",
    "apps.finance",
    "apps.events",
    "apps.groups",
    "apps.sermons",
    "apps.communications",
]

INSTALLED_APPS = list(set(SHARED_APPS + TENANT_APPS))

TENANT_MODEL = "tenants.Church"
TENANT_DOMAIN_MODEL = "tenants.Domain"

# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------
MIDDLEWARE = [
    "django_tenants.middleware.main.TenantMainMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
PUBLIC_SCHEMA_URLCONF = "config.urls_public"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

# ---------------------------------------------------------------------------
# Database — django-tenants requires the postgresql backend
# ---------------------------------------------------------------------------
database_url = os.environ.get("DATABASE_URL")
if database_url:
    from urllib.parse import urlparse, parse_qs
    parsed = urlparse(database_url)
    qs = parse_qs(parsed.query)
    sslmode = qs.get("sslmode", ["require"])[0]
    DATABASES = {
        "default": {
            "ENGINE": "django_tenants.postgresql_backend",
            "NAME": parsed.path.lstrip("/"),
            "USER": parsed.username,
            "PASSWORD": parsed.password,
            "HOST": parsed.hostname,
            "PORT": str(parsed.port or 5432),
            "OPTIONS": {"sslmode": sslmode},
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django_tenants.postgresql_backend",
            "NAME": os.environ.get("POSTGRES_DB", "churchms"),
            "USER": os.environ.get("POSTGRES_USER", "churchms"),
            "PASSWORD": os.environ.get("POSTGRES_PASSWORD", ""),
            "HOST": os.environ.get("POSTGRES_HOST", "localhost"),
            "PORT": os.environ.get("POSTGRES_PORT", "5432"),
        }
    }

DATABASE_ROUTERS = ("django_tenants.routers.TenantSyncRouter",)

# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------
AUTH_USER_MODEL = "accounts.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=int(os.environ.get("JWT_ACCESS_MINUTES", 60))),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=int(os.environ.get("JWT_REFRESH_DAYS", 7))),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "user_id",
}

# ---------------------------------------------------------------------------
# REST Framework
# ---------------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_PAGINATION_CLASS": "config.pagination.StandardResultsSetPagination",
    "PAGE_SIZE": 25,
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_THROTTLE_RATES": {
        # Broadcast send/retry requests per user (ScopedRateThrottle).
        "sms_send": os.environ.get("SMS_SEND_RATE", "20/hour"),
    },
}

# ---------------------------------------------------------------------------
# API Documentation (drf-spectacular)
# ---------------------------------------------------------------------------
SPECTACULAR_SETTINGS = {
    "TITLE": "ChurchMS API",
    "DESCRIPTION": "Multi-tenant Church Management System REST API",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
}

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
# Origins are scheme + host only, so 'https://app.example.com/login' is reduced to 'https://app.example.com'.
CORS_ALLOWED_ORIGINS = [
    o.split("://", 1)[0] + "://" + _bare_host(o) if "://" in o else o
    for o in _env_list("CORS_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
]
CORS_ALLOW_CREDENTIALS = True

# ---------------------------------------------------------------------------
# Static / Media
# ---------------------------------------------------------------------------
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_STORAGE = "whitenoise.storage.CompressedManifestStaticFilesStorage"
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

# ---------------------------------------------------------------------------
# S3 Storage (django-storages)
# ---------------------------------------------------------------------------
if os.environ.get("USE_S3", "False") == "True":
    DEFAULT_FILE_STORAGE = "storages.backends.s3boto3.S3Boto3Storage"
    AWS_ACCESS_KEY_ID = os.environ.get("AWS_ACCESS_KEY_ID")
    AWS_SECRET_ACCESS_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY")
    AWS_STORAGE_BUCKET_NAME = os.environ.get("AWS_STORAGE_BUCKET_NAME")
    AWS_S3_ENDPOINT_URL = os.environ.get("AWS_S3_ENDPOINT_URL")  # MinIO-compatible
    AWS_S3_CUSTOM_DOMAIN = os.environ.get("AWS_S3_CUSTOM_DOMAIN")
    AWS_DEFAULT_ACL = "private"
    AWS_S3_FILE_OVERWRITE = False

# ---------------------------------------------------------------------------
# Celery
# ---------------------------------------------------------------------------
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
CELERY_BROKER_URL = REDIS_URL
CELERY_RESULT_BACKEND = "django-db"
CELERY_CACHE_BACKEND = "default"
CELERY_BEAT_SCHEDULER = "django_celery_beat.schedulers:DatabaseScheduler"
CELERY_TASK_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TIMEZONE = "UTC"
CELERY_TASK_TRACK_STARTED = True

# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": REDIS_URL,
    }
}

# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------
EMAIL_BACKEND = os.environ.get(
    "EMAIL_BACKEND", "django.core.mail.backends.console.EmailBackend"
)
EMAIL_HOST = os.environ.get("EMAIL_HOST", "")
EMAIL_PORT = int(os.environ.get("EMAIL_PORT", 587))
EMAIL_USE_TLS = True
EMAIL_HOST_USER = os.environ.get("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.environ.get("EMAIL_HOST_PASSWORD", "")
DEFAULT_FROM_EMAIL = os.environ.get("DEFAULT_FROM_EMAIL", "noreply@churchms.com")

# ---------------------------------------------------------------------------
# SMS — AgooSMS (see docs/SMS_AGOOSMS.md)
# ---------------------------------------------------------------------------
AGOOSMS_BASE_URL = os.environ.get("AGOOSMS_BASE_URL", "https://api.agoosms.com")
# Secret: set ONE of these. Never commit a real key.
AGOOSMS_API_KEY = os.environ.get("AGOOSMS_API_KEY", "")
AGOOSMS_API_KEY_SSM_PARAMETER = os.environ.get("AGOOSMS_API_KEY_SSM_PARAMETER", "")  # AWS SSM SecureString name
AGOOSMS_API_KEY_SECRET_ID = os.environ.get("AGOOSMS_API_KEY_SECRET_ID", "")  # AWS Secrets Manager id/ARN
AWS_REGION = os.environ.get("AWS_REGION", "")
# Approved sender ID(s), comma-separated; the first is the default.
AGOOSMS_SENDER_ID = os.environ.get("AGOOSMS_SENDER_ID", "")
AGOOSMS_TIMEOUT = float(os.environ.get("AGOOSMS_TIMEOUT", 30))
# Recipients per bulk request. The provider's limit is undocumented; keep conservative.
AGOOSMS_MAX_BULK = int(os.environ.get("AGOOSMS_MAX_BULK", 100))
# Test mode: messages are recorded as "simulated" and never sent. Must be explicitly
# set to False in production to send real SMS.
SMS_DRY_RUN = os.environ.get("SMS_DRY_RUN", "True").strip().lower() in ("true", "1", "yes")
SMS_LARGE_BROADCAST_THRESHOLD = int(os.environ.get("SMS_LARGE_BROADCAST_THRESHOLD", 25))
SMS_MAX_RECIPIENTS = int(os.environ.get("SMS_MAX_RECIPIENTS", 5000))
SMS_MAX_MESSAGE_LENGTH = int(os.environ.get("SMS_MAX_MESSAGE_LENGTH", 918))

# ---------------------------------------------------------------------------
# Phone number
# ---------------------------------------------------------------------------
PHONENUMBER_DEFAULT_REGION = "US"

# ---------------------------------------------------------------------------
# Internationalization
# ---------------------------------------------------------------------------
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
