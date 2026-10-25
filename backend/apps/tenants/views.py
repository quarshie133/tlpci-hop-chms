from django.db import transaction
from rest_framework import generics, permissions, status
from rest_framework.response import Response

from .models import Church, Domain
from .serializers import ChurchRegistrationSerializer, ChurchSerializer


class ChurchRegistrationView(generics.CreateAPIView):
    """Public endpoint: register a new church (creates schema + admin user)."""

    serializer_class = ChurchRegistrationSerializer
    permission_classes = [permissions.AllowAny]

    @transaction.atomic
    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        data = serializer.validated_data
        base_domain = request.get_host().split(":")[0]  # e.g. churchms.com

        # Create tenant
        church = Church(
            name=data["name"],
            slug=data["slug"],
            schema_name=data["slug"].replace("-", "_"),
            email=data.get("email", ""),
            phone=data.get("phone", ""),
            city=data.get("city", ""),
            state=data.get("state", ""),
            country=data.get("country", "US"),
            timezone=data.get("timezone", "UTC"),
            currency=data.get("currency", "GHS"),
        )
        church.save()  # triggers schema creation

        # Create primary domain
        Domain.objects.create(
            domain=f"{data['subdomain']}.{base_domain}",
            tenant=church,
            is_primary=True,
        )

        # Create admin user within new schema
        from django_tenants.utils import schema_context
        from apps.accounts.models import User

        with schema_context(church.schema_name):
            user = User.objects.create_superuser(
                email=data["admin_email"],
                password=data["admin_password"],
                first_name=data["admin_first_name"],
                last_name=data["admin_last_name"],
                role="church_admin",
            )

        return Response(
            {
                "message": "Church registered successfully.",
                "church": ChurchSerializer(church).data,
                "admin_email": user.email,
            },
            status=status.HTTP_201_CREATED,
        )


class ChurchDetailView(generics.RetrieveUpdateAPIView):
    """Retrieve/update the current church (tenant-context aware)."""

    serializer_class = ChurchSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self):
        return self.request.tenant
