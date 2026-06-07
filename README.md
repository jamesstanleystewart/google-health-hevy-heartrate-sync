# hevy-hr-sync

A serverless webhook that enriches Hevy workouts with heart-rate data pulled from the Google Health API (Fitbit successor).

Hevy's public API can read workouts but cannot write biometrics. This service:

1. Receives a `workout.created` webhook from Hevy
2. Fetches the workout structure (exercises, sets, reps, weights, completed-at times)
3. Pulls high-resolution heart-rate samples from Google Health for the workout's time window
4. Clones the workout via Hevy's private mobile API with the HR series injected
5. Optionally deletes the original (controlled by `SKIP_DELETE`)

## Architecture

```
Hevy webhook (POST {workoutId})
        |
        v
  +-------------------------------------------------------+
  | Cloud Run Function (Gen2, Node 20, 1 vCPU, 512 MiB)   |
  |                                                       |
  |  1. Verify Authorization header (shared secret)       |
  |  2. ack 200 to Hevy                                   |
  |  3. background pipeline:                              |
  |       a. Hevy v1 GET  /v1/workouts/{id}     (api-key) |
  |       b. Hevy v2 GET  /workout/{id}    (mobile token) |
  |       c. Google OAuth refresh                         |
  |       d. Google Health v4 GET heart-rate dataPoints   |
  |       e. build clone PostWorkout payload              |
  |       f. Hevy v2 POST /v2/workout                     |
  |       g. Hevy v2 DELETE /workout/{id}  (gated)        |
  +-------------------------------------------------------+
        |
        v
  gs://<bucket>/hevy-tokens.json   (Hevy session,
                                    if-generation-match writes)
```

Why two Hevy APIs:

- **v1 (public)** — used to read workout structure with weights/reps/distances. Rejects biometric writes.
- **v2 (private mobile)** — reverse-engineered from the Hevy mobile app. Accepts biometrics. Auth is OAuth tokens extracted from the `auth2.0-token` cookie at `app.hevyapp.com`. Access tokens expire in ~15-60 min, refresh tokens rotate on every refresh call.

## Credits

This project stands on the shoulders of [iAm9001/HevyHeart](https://github.com/iAm9001/HevyHeart), a C# desktop app that does the same enrichment using Strava as the HR source. HevyHeart figured out:

- The mobile API's `PostWorkout` payload shape (`workout.biometrics.heart_rate_samples`)
- The mobile fingerprint headers (`X-Api-Key: klean_kanteen_insulated`, `Hevy-App-Version`, etc.)
- The endpoint path inconsistency (`POST /v2/workout` vs `GET/DELETE /workout/{id}`)
- The cookie-based OAuth flow and refresh-token rotation behaviour

Without that prior reverse-engineering this would have been a much longer project.

## Prerequisites

- A GCP project with billing enabled (required even for free-tier usage)
- Hevy Pro subscription (needed for webhook + v1 API access)
- Google Health data (e.g. Fitbit account migrated to Google Health)
- `gcloud` CLI authenticated to your GCP account
- Node 20+ for local dev

## Setup

### 1. Hevy credentials

Two sets:

- **v1 API key** (UUID): `app.hevyapp.com` → Settings → Developer/API
- **v2 mobile session**: log in at `app.hevyapp.com`, open DevTools → Application → Cookies → find `auth2.0-token`. URL-decode the value (paste into `decodeURIComponent("...")` in DevTools console). The resulting JSON contains `access_token`, `refresh_token`, `expires_at`.

### 2. Google Health OAuth

In your GCP project:

1. Enable the **Google Health API** (`health.googleapis.com`)
2. Configure the **OAuth consent screen** → External → add scope `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly` → add your Google account as a test user
3. Create an **OAuth 2.0 Client ID** → Web application → add `https://developers.google.com/oauthplayground` as an Authorized redirect URI
4. Use [OAuth Playground](https://developers.google.com/oauthplayground) with "Use your own OAuth credentials" to exchange an authorization code for a refresh token

### 3. GCS bucket for token storage

```bash
gcloud storage buckets create gs://YOUR_BUCKET \
  --location=us-central1 \
  --uniform-bucket-level-access \
  --public-access-prevention
```

Grant the function's runtime service account read/write:

```bash
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT --format='value(projectNumber)')
gcloud storage buckets add-iam-policy-binding gs://YOUR_BUCKET \
  --member=serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com \
  --role=roles/storage.objectUser
```

### 4. `.env`

Copy `.env.example` to `.env` and fill in:

```
HEVY_API_KEY=...
HEVY_ACCESS_TOKEN=...
HEVY_REFRESH_TOKEN=...
HEVY_EXPIRES_AT=...
HEVY_TOKEN_BUCKET=YOUR_BUCKET
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
SKIP_DELETE=true
WEBHOOK_AUTH_HEADER="Bearer hwh_..."
```

Quote any value containing spaces (the deploy script reads `.env` via `source`).

### 5. Local read-only verification

```bash
npm install
TEST_WORKOUT_ID=<some-real-workout-uuid> npm run dry-run
```

Walks the full read pipeline (Google OAuth → Hevy v1 → Google Health → Hevy v2 → build payload) and writes the would-be clone to `scripts/last-payload.json`. No mutations.

To actually POST a clone to Hevy (still no DELETE):

```bash
LIVE=true STEPS=post npm run dry-run
```

### 6. Deploy

```bash
./scripts/deploy.sh
```

The script:

1. Reads `.env`
2. Generates an ephemeral `.env.yaml` (deleted on exit) — secrets never appear on stdout or in shell history
3. Deploys the Gen2 function with `--allow-unauthenticated` (auth handled by the shared-secret header)
4. Patches the underlying Cloud Run service with `--cpu=1 --no-cpu-throttling` so background work after the 200-ack runs at full speed (without this, post-ack work is throttled ~10×)

### 7. Wire the Hevy webhook

In Hevy's webhook settings:

- **URL**: the function URL printed by the deploy script
- **Authorization header**: the same `Bearer hwh_...` value from your `.env`

Hevy expects a 200 response within 5 seconds; the function acks immediately and processes asynchronously.

## Token rotation

Hevy access tokens expire fast and refresh tokens are single-use. The function manages this:

1. On cold start, read tokens from `gs://YOUR_BUCKET/hevy-tokens.json`
2. If the object doesn't exist, bootstrap from `.env` and write the initial state
3. If the access token is expired or near-expiry, call `/auth/refresh_token` and atomically write the new pair to GCS (`if-generation-match`)
4. Warm invocations reuse the cached in-process session

To force a re-bootstrap (e.g. after a long downtime where the refresh token chain died):

```bash
gcloud storage rm gs://YOUR_BUCKET/hevy-tokens.json
```

Then update `HEVY_ACCESS_TOKEN` / `HEVY_REFRESH_TOKEN` / `HEVY_EXPIRES_AT` in `.env` with fresh values from the `auth2.0-token` cookie and redeploy.

## GCP cost (free tier)

Estimated monthly cost for personal usage (~5 workouts/week):

| Service | Free tier | Expected usage | Charge |
|---|---|---|---|
| Cloud Run Functions invocations | 2M / month | ~20 | $0 |
| Cloud Run vCPU-seconds | 240,000 / month | ~600 | $0 |
| Cloud Run memory (GB-s) | 480,000 / month | ~150 | $0 |
| Cloud Build minutes | 120 / day | ~5 per deploy | $0 |
| Artifact Registry storage | 0.5 GB | ~150 MB image | $0 |
| Cloud Storage (Standard) | 5 GB-month | <1 KB token blob | $0 |
| Cloud Logging | 50 GiB / month | <1 MB | $0 |
| Egress (within North America) | 1 GB / month | ~10 MB | $0 |

Effective cost: **$0/month indefinitely**. Setting a Cloud Billing budget alert at $1 is recommended insurance against runaway costs from misconfiguration or abuse.

## `SKIP_DELETE` workflow

First deploy and first real webhook should use `SKIP_DELETE=true`:

- Function creates a clone with HR data
- Original workout is preserved
- You manually verify the clone in Hevy and delete the duplicate

After confirming it works end-to-end on a real webhook, flip to auto-swap:

```
SKIP_DELETE=false
```

Then `./scripts/deploy.sh`. From that point on, future workouts get cloned-with-HR and the original is deleted atomically.

The safety gate in `processWorkout` ensures DELETE only fires when the clone POST returned 200/201. If the clone fails for any reason, the original is always preserved.

## Known limitations

- **HR data must exist in Google Health for the workout window.** If Google Health has no samples (Fitbit hadn't synced, device wasn't worn, etc.), the function logs a WARN and exits without creating a clone.
- **Concurrent invocations may race on token refresh.** Handled via GCS `if-generation-match` — the loser re-reads. For a single-user personal account this is essentially never an issue.
- **The mobile API surface can change without notice.** If Hevy rotates the hardcoded keys (`klean_kanteen_insulated`, `with_great_power`) or bumps the app build/version checks, the function will start returning 401s. Update `MOBILE_HEADERS` in `src/index.ts` and redeploy.

## Local development

```bash
npm install
npm run build           # compile TypeScript
npm run dev             # compile + run functions-framework on :8080
TEST_WORKOUT_ID=<uuid> npm run dry-run                # full read pipeline, no mutations
STEPS=hevy-v2 npm run dry-run                         # one step
LIVE=true STEPS=post npm run dry-run                  # POST a clone, never DELETE
```

Project layout:

```
src/
  index.ts              entry point — webhook handler + pipeline
scripts/
  deploy.sh             generate env yaml, deploy, patch Cloud Run service
  dry-run.ts            local pipeline harness
.env.example            env vars list (real .env is gitignored)
```

Gitignored: `.env`, `.env.yaml`, `scripts/webhook-auth.txt`, `scripts/new-tokens.env`, `scripts/last-payload.json`, `node_modules`, `dist`.
