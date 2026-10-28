#!/usr/bin/env bash
# Render web service start command: `bash start.sh` (Root Directory: backend).
# Runs the Celery worker that sends SMS alongside gunicorn, so no separate
# (paid) Background Worker service is needed. Set RUN_CELERY_WORKER=false if
# a dedicated worker service is added later.
set -e

if [ "${RUN_CELERY_WORKER:-true}" = "true" ]; then
  # Restart the worker if it ever exits; queued jobs wait safely in Redis.
  (
    while true; do
      celery -A config worker --loglevel=info --pool=solo \
        --without-gossip --without-mingle --without-heartbeat || true
      echo "Celery worker exited; restarting in 5s" >&2
      sleep 5
    done
  ) &
fi

exec gunicorn config.wsgi:application --bind "0.0.0.0:${PORT:-8000}" --workers "${WEB_CONCURRENCY:-2}" --timeout 120
