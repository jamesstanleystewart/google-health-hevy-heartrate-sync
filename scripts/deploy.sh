#!/usr/bin/env bash
# Deploys the function. Reads secrets from .env so they never appear in stdout
# or shell history. Generates an ephemeral .env.yaml that gcloud accepts via
# --env-vars-file, then deletes it.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# Required vars — fail fast if any are missing.
REQUIRED=(
  HEVY_API_KEY
  HEVY_ACCESS_TOKEN
  HEVY_REFRESH_TOKEN
  HEVY_TOKEN_BUCKET
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  GOOGLE_REFRESH_TOKEN
)

# shellcheck disable=SC1091
set -a; source .env; set +a

missing=()
for v in "${REQUIRED[@]}"; do
  if [ -z "${!v:-}" ]; then missing+=("$v"); fi
done
if [ ${#missing[@]} -ne 0 ]; then
  echo "ERROR: missing env vars in .env: ${missing[*]}" >&2
  exit 1
fi

REGION="${REGION:-us-central1}"
FUNCTION_NAME="${FUNCTION_NAME:-hevy-hr-sync}"
SKIP_DELETE="${SKIP_DELETE:-true}"   # first-pass safety on by default
HEVY_TOKEN_OBJECT="${HEVY_TOKEN_OBJECT:-hevy-tokens.json}"
HEVY_EXPIRES_AT="${HEVY_EXPIRES_AT:-}"

# Build ephemeral env file. YAML — gcloud accepts this via --env-vars-file.
# Trap ensures it's deleted on any exit path.
ENV_YAML="$(mktemp -t hevy-env.XXXXXX).yaml"
trap 'rm -f "$ENV_YAML"' EXIT

WEBHOOK_AUTH_HEADER="${WEBHOOK_AUTH_HEADER:-}"

cat > "$ENV_YAML" <<EOF
HEVY_API_KEY: "${HEVY_API_KEY}"
HEVY_ACCESS_TOKEN: "${HEVY_ACCESS_TOKEN}"
HEVY_REFRESH_TOKEN: "${HEVY_REFRESH_TOKEN}"
HEVY_EXPIRES_AT: "${HEVY_EXPIRES_AT}"
HEVY_TOKEN_BUCKET: "${HEVY_TOKEN_BUCKET}"
HEVY_TOKEN_OBJECT: "${HEVY_TOKEN_OBJECT}"
GOOGLE_CLIENT_ID: "${GOOGLE_CLIENT_ID}"
GOOGLE_CLIENT_SECRET: "${GOOGLE_CLIENT_SECRET}"
GOOGLE_REFRESH_TOKEN: "${GOOGLE_REFRESH_TOKEN}"
SKIP_DELETE: "${SKIP_DELETE}"
WEBHOOK_AUTH_HEADER: "${WEBHOOK_AUTH_HEADER}"
EOF

echo "Deploying $FUNCTION_NAME to $REGION (SKIP_DELETE=$SKIP_DELETE)..."

# Every `gcloud functions deploy` resets the Cloud Run CPU setting to the
# Gen2 default (0.1666 vCPU), which is incompatible with always-allocated.
# Temporarily re-enable throttling so the deploy doesn't 400, then restore
# after.
if gcloud run services describe "$FUNCTION_NAME" --region="$REGION" --quiet >/dev/null 2>&1; then
  echo "Reverting CPU throttling for deploy compatibility..."
  gcloud run services update "$FUNCTION_NAME" \
    --region="$REGION" --cpu-throttling --quiet \
    --format='value(metadata.name)' >/dev/null 2>&1 || true
fi

# --format suppresses the post-deploy YAML dump that includes env-var values.
gcloud functions deploy "$FUNCTION_NAME" \
  --gen2 \
  --runtime=nodejs20 \
  --region="$REGION" \
  --source=. \
  --entry-point=hevyWebhook \
  --trigger-http \
  --allow-unauthenticated \
  --memory=256Mi \
  --timeout=60s \
  --env-vars-file="$ENV_YAML" \
  --format='value(serviceConfig.uri)'

# Cloud Run-side: keep CPU allocated outside request lifecycle so background
# work after the 200-ack runs at full speed (not the ~10× throttled default).
# --gen2 functions are Cloud Run services under the hood; this flag isn't
# exposed by `gcloud functions deploy` so we patch the service directly.
echo "Setting CPU always-allocated on the backing Cloud Run service..."
# --no-cpu-throttling requires >= 1 vCPU. Bumping cpu/memory to satisfy it.
# Cost stays effectively $0 for personal usage (~5 invocations/week).
gcloud run services update "$FUNCTION_NAME" \
  --region="$REGION" \
  --cpu=1 \
  --memory=512Mi \
  --no-cpu-throttling \
  --quiet \
  --format='value(metadata.name)' >/dev/null

echo
echo "Function URL:"
gcloud functions describe "$FUNCTION_NAME" --region="$REGION" --gen2 --format='value(serviceConfig.uri)'
