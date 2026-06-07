import { http, Request, Response } from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import axios, { AxiosError, AxiosInstance } from 'axios';

// ============================================================================
// Background
// ============================================================================
// The PUBLIC Hevy v1 API (api.hevyapp.com/v1) does not accept biometric writes
// on POST /workouts. To inject heart-rate samples we have to use the PRIVATE
// mobile v2 API surface (POST /v2/workout, DELETE /v2/workout/{id}) discovered
// by HevyHeart (github.com/iAm9001/HevyHeart). That surface is undocumented and
// can break at any time if Hevy rotates the mobile keys or fingerprints traffic.
//
// Auth on v2 is a Bearer access_token + refresh_token pair extracted from the
// `auth2.0-token` cookie at app.hevyapp.com (DevTools > Application > Cookies).
// The username/password endpoint was deprecated around Feb 2026.
//
// The v1 UUID api-key is still used for: (a) reading the original workout to
// preserve weights/reps/distances (v1 GET), (b) the inbound webhook channel.
// V2 GET enriches with rest_seconds / completed_at — we do a hybrid read so the
// clone preserves as much fidelity as possible.

// ============================================================================
// Config
// ============================================================================

const HEVY_API_KEY = process.env.HEVY_API_KEY ?? '';
const HEVY_ACCESS_TOKEN = process.env.HEVY_ACCESS_TOKEN ?? '';
const HEVY_REFRESH_TOKEN = process.env.HEVY_REFRESH_TOKEN ?? '';
const HEVY_EXPIRES_AT = process.env.HEVY_EXPIRES_AT ?? '';

// GCS-backed token store: refresh tokens rotate on every call, so we persist
// the {access, refresh, expires_at} triple as a single JSON object in GCS,
// using if-generation-match for race safety across concurrent invocations.
// Env vars above are the bootstrap source — once GCS has data, it's authoritative.
const HEVY_TOKEN_BUCKET = process.env.HEVY_TOKEN_BUCKET ?? '';
const HEVY_TOKEN_OBJECT = process.env.HEVY_TOKEN_OBJECT ?? 'hevy-tokens.json';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN ?? '';

// Safety toggle: when SKIP_DELETE=true, the function POSTs the enriched clone
// but does NOT delete the original. Use this for first-pass verification so
// you can eyeball both workouts in Hevy before trusting the swap end-to-end.
const SKIP_DELETE = (process.env.SKIP_DELETE ?? '').toLowerCase() === 'true';

// Shared secret Hevy sends back as the Authorization header. If unset, the
// function accepts anonymous requests (dev mode). In prod, set this in both
// the deployed env vars AND Hevy's webhook config — exact match required.
const WEBHOOK_AUTH_HEADER = process.env.WEBHOOK_AUTH_HEADER ?? '';

const HEVY_BASE = 'https://api.hevyapp.com';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// URL uses kebab-case data-type id (`heart-rate`); the filter expression below
// uses snake_case (`heart_rate.sample_time.physical_time`).
const HEALTH_HR_URL =
  'https://health.googleapis.com/v4/users/me/dataTypes/heart-rate/dataPoints';

// Mobile-app fingerprint headers required by the private v2 API.
// Source: HevyHeart's HevyService.cs. Bump if Hevy rejects an older build.
const MOBILE_HEADERS = {
  'X-Api-Key': 'klean_kanteen_insulated',
  'Hevy-App-Version': '2.5.6',
  'Hevy-App-Build': '1819922',
  'Hevy-Platform': 'android 36',
};
const WEB_API_KEY = 'with_great_power'; // used by /auth/refresh_token

function assertEnv(): void {
  const missing = (
    [
      ['HEVY_API_KEY', HEVY_API_KEY],
      ['HEVY_ACCESS_TOKEN', HEVY_ACCESS_TOKEN],
      ['HEVY_REFRESH_TOKEN', HEVY_REFRESH_TOKEN],
      ['GOOGLE_CLIENT_ID', GOOGLE_CLIENT_ID],
      ['GOOGLE_CLIENT_SECRET', GOOGLE_CLIENT_SECRET],
      ['GOOGLE_REFRESH_TOKEN', GOOGLE_REFRESH_TOKEN],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

// ============================================================================
// Structured logging
// ============================================================================

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

function log(level: LogLevel, message: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ severity: level, message, ...extra }));
}

// ============================================================================
// 1) Webhook parsing
// ============================================================================

interface WebhookBody {
  // Hevy's documented field
  workoutId?: string;
  // Tolerate other shapes (synthetic tests, future Hevy changes)
  id?: string;
  workout_id?: string;
  payload?: { workoutId?: string; id?: string };
  start_time?: string | number;
  end_time?: string | number;
}

function extractWorkoutId(body: WebhookBody): string {
  const id =
    body.workoutId ??
    body.id ??
    body.workout_id ??
    body.payload?.workoutId ??
    body.payload?.id;
  if (!id) throw new Error('Webhook body missing workout id');
  return id;
}

function toUnixSeconds(t: string | number | null | undefined): number | null {
  if (t == null) return null;
  if (typeof t === 'number') {
    return t < 1e12 ? Math.floor(t) : Math.floor(t / 1000);
  }
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

function toIsoUtc(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

// ============================================================================
// 2) Google OAuth refresh
// ============================================================================

export async function getGoogleAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const { data } = await axios.post<{ access_token?: string }>(
    GOOGLE_TOKEN_URL,
    body,
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
    },
  );
  if (!data.access_token) throw new Error('Google OAuth response missing access_token');
  return data.access_token;
}

// ============================================================================
// 3) Google Health API v4 — heart rate samples in a time window
// ============================================================================

export interface HeartRateSample {
  bpm: number;
  timestamp_ms: number;
}

export async function fetchHeartRate(
  accessToken: string,
  startIso: string,
  endIso: string,
): Promise<HeartRateSample[]> {
  // v4 uses an AIP-160 filter expression for time ranges. For sample data
  // types like heart_rate, the field is `heart_rate.sample_time.physical_time`.
  const filter =
    `heart_rate.sample_time.physical_time >= "${startIso}" ` +
    `AND heart_rate.sample_time.physical_time < "${endIso}"`;

  const samples: HeartRateSample[] = [];
  let pageToken: string | undefined;

  do {
    const { data } = await axios.get<{
      dataPoints?: Array<{
        heartRate?: {
          beatsPerMinute?: number | string;
          sampleTime?: { physicalTime?: string };
        };
      }>;
      nextPageToken?: string;
    }>(HEALTH_HR_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        filter,
        pageSize: 1000,
        ...(pageToken ? { pageToken } : {}),
      },
      timeout: 20_000,
    });

    for (const dp of data.dataPoints ?? []) {
      const hr = dp.heartRate;
      const rawTs = hr?.sampleTime?.physicalTime;
      if (!hr?.beatsPerMinute || !rawTs) continue;

      const ms = new Date(rawTs).getTime();
      if (Number.isNaN(ms)) continue;

      samples.push({ bpm: Number(hr.beatsPerMinute), timestamp_ms: ms });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  samples.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return samples;
}

// ============================================================================
// 4) Hevy v2 (private mobile) auth — GCS-backed session, refresh on expiry
// ============================================================================

interface PersistedTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

interface LoadedSession {
  tokens: PersistedTokens;
  generation: string; // GCS object generation, for if-generation-match writes
}

const storage = new Storage();
// Process-level cache so we don't re-read GCS on every call within one warm
// invocation. Cleared by Cloud Run between cold starts, which is fine.
let cachedSession: LoadedSession | null = null;

function isAccessTokenExpired(t: PersistedTokens): boolean {
  if (!t.expires_at) return true; // unknown → force refresh
  const expiry = new Date(t.expires_at).getTime();
  if (Number.isNaN(expiry)) return true;
  return expiry <= Date.now() + 60_000; // 60s buffer
}

async function loadFromGcs(): Promise<LoadedSession | null> {
  if (!HEVY_TOKEN_BUCKET) return null;
  const file = storage.bucket(HEVY_TOKEN_BUCKET).file(HEVY_TOKEN_OBJECT);
  try {
    const [buf] = await file.download();
    const [meta] = await file.getMetadata();
    return {
      tokens: JSON.parse(buf.toString()) as PersistedTokens,
      generation: String(meta.generation),
    };
  } catch (err) {
    if ((err as { code?: number }).code === 404) return null;
    throw err;
  }
}

async function saveToGcs(
  tokens: PersistedTokens,
  ifGenerationMatch: string,
): Promise<string> {
  const file = storage.bucket(HEVY_TOKEN_BUCKET).file(HEVY_TOKEN_OBJECT);
  await file.save(JSON.stringify(tokens, null, 2), {
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache' },
    preconditionOpts: { ifGenerationMatch: Number(ifGenerationMatch) },
  });
  const [meta] = await file.getMetadata();
  return String(meta.generation);
}

async function callHevyRefresh(current: PersistedTokens): Promise<PersistedTokens> {
  const { data } = await axios.post<PersistedTokens>(
    `${HEVY_BASE}/auth/refresh_token`,
    { refresh_token: current.refresh_token },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': WEB_API_KEY,
        Authorization: `Bearer ${current.access_token}`,
      },
      timeout: 10_000,
    },
  );
  return data;
}

async function ensureHevySession(): Promise<string> {
  // First-call bootstrap: prefer GCS, fall back to env vars.
  if (!cachedSession) {
    const fromGcs = await loadFromGcs();
    if (fromGcs) {
      log('INFO', 'loaded Hevy session from GCS', {
        expires_at: fromGcs.tokens.expires_at,
        generation: fromGcs.generation,
      });
      cachedSession = fromGcs;
    } else {
      log('WARN', 'no GCS session — bootstrapping from env vars');
      const bootstrap: PersistedTokens = {
        access_token: HEVY_ACCESS_TOKEN,
        refresh_token: HEVY_REFRESH_TOKEN,
        expires_at: HEVY_EXPIRES_AT || new Date(0).toISOString(),
      };
      if (HEVY_TOKEN_BUCKET) {
        try {
          // generation:0 → "create only if doesn't exist" — wins the race.
          const gen = await saveToGcs(bootstrap, '0');
          cachedSession = { tokens: bootstrap, generation: gen };
        } catch (err) {
          if ((err as { code?: number }).code === 412) {
            // Lost the bootstrap race — another instance got there first.
            const reread = await loadFromGcs();
            if (!reread) throw err;
            cachedSession = reread;
          } else {
            throw err;
          }
        }
      } else {
        cachedSession = { tokens: bootstrap, generation: '0' };
      }
    }
  }

  if (!isAccessTokenExpired(cachedSession.tokens)) {
    return cachedSession.tokens.access_token;
  }

  log('INFO', 'Hevy access token expired, refreshing');
  const fresh = await callHevyRefresh(cachedSession.tokens);

  if (!HEVY_TOKEN_BUCKET) {
    cachedSession = { tokens: fresh, generation: '0' };
    log('WARN', 'No HEVY_TOKEN_BUCKET — rotated tokens NOT persisted, will fail on next cold start');
    return fresh.access_token;
  }

  try {
    const newGen = await saveToGcs(fresh, cachedSession.generation);
    cachedSession = { tokens: fresh, generation: newGen };
    log('INFO', 'rotated Hevy tokens persisted to GCS', {
      new_expires_at: fresh.expires_at,
      generation: newGen,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 412) {
      // Concurrent refresh — re-read GCS. Our `fresh` tokens are now stale
      // because Hevy invalidated them when the other instance refreshed.
      log('WARN', 'GCS generation mismatch on token write, re-reading');
      const reread = await loadFromGcs();
      if (!reread) throw err;
      cachedSession = reread;
    } else {
      throw err;
    }
  }

  return cachedSession.tokens.access_token;
}

// ============================================================================
// 5) Hevy API — hybrid GET (v1 + v2), v2 POST clone, v2 DELETE original
// ============================================================================

const hevyV1: AxiosInstance = axios.create({
  baseURL: HEVY_BASE,
  headers: { 'api-key': HEVY_API_KEY, 'Content-Type': 'application/json' },
  timeout: 15_000,
});

export interface V1Set {
  index: number;
  type: string;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
  custom_metric?: number | string | null;
}
export interface V1Exercise {
  exercise_template_id: string;
  title: string;
  notes?: string;
  superset_id?: number | null;
  sets: V1Set[];
}
export interface V1Workout {
  id: string;
  title: string;
  description?: string;
  start_time: string | number;
  end_time: string | number;
  routine_id?: string;
  exercises: V1Exercise[];
}

export interface V2Set {
  completed_at?: string;
}
export interface V2Exercise {
  exercise_template_id: string;
  title: string;
  rest_seconds?: number;
  volume_doubling_enabled?: boolean;
  sets: V2Set[];
}
export interface V2Workout {
  trainer_program_id?: string;
  exercises: V2Exercise[];
  biometrics?: {
    heart_rate_samples?: unknown[];
    total_calories?: number;
  };
}

export async function getWorkoutV1(id: string): Promise<V1Workout> {
  const { data } = await hevyV1.get<{ workout?: V1Workout } | V1Workout>(
    `/v1/workouts/${id}`,
  );
  const w = (data as { workout?: V1Workout }).workout ?? (data as V1Workout);
  if (!w?.exercises) throw new Error('v1 GET returned no exercises');
  return w;
}

async function getWorkoutV2(id: string): Promise<V2Workout> {
  const token = await ensureHevySession();
  // Note the inconsistency: GET/DELETE use /workout/{id} (no /v2 prefix),
  // while POST uses /v2/workout. Matches HevyHeart's reverse-engineered paths.
  const { data } = await axios.get<{ workout?: V2Workout } | V2Workout>(
    `${HEVY_BASE}/workout/${id}`,
    {
      headers: {
        ...MOBILE_HEADERS,
        Authorization: `Bearer ${token}`,
      },
      timeout: 15_000,
    },
  );
  return (data as { workout?: V2Workout }).workout ?? (data as V2Workout);
}

export interface CloneSet {
  index: number;
  type: string;
  weight_kg: number | null;
  reps: number | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  rpe: number | null;
  custom_metric: number | string | null;
  completed_at: string;
}
export interface CloneExercise {
  exercise_template_id: string;
  title: string;
  notes: string;
  rest_timer_seconds: number;
  volume_doubling_enabled: boolean;
  superset_id: number | null;
  sets: CloneSet[];
}

function mergeExercises(v1: V1Workout, v2: V2Workout): CloneExercise[] {
  return v1.exercises.map((v1ex) => {
    const v2ex = v2.exercises?.find(
      (e) =>
        e.exercise_template_id === v1ex.exercise_template_id &&
        e.title === v1ex.title,
    );

    const sets: CloneSet[] = v1ex.sets.map((s, i) => ({
      index: s.index,
      type: s.type,
      // Pass nulls through faithfully — Hevy validates per exercise_type and
      // rejects e.g. weight_kg=0 for duration-only sets.
      weight_kg: s.weight_kg ?? null,
      reps: s.reps ?? null,
      distance_meters: s.distance_meters ?? null,
      duration_seconds: s.duration_seconds ?? null,
      rpe: s.rpe ?? null,
      custom_metric: s.custom_metric ?? null,
      completed_at: v2ex?.sets?.[i]?.completed_at ?? '',
    }));

    return {
      exercise_template_id: v1ex.exercise_template_id,
      title: v1ex.title,
      notes: v1ex.notes ?? '',
      rest_timer_seconds: v2ex?.rest_seconds ?? 0,
      volume_doubling_enabled: v2ex?.volume_doubling_enabled ?? false,
      superset_id: v1ex.superset_id ?? null,
      sets,
    };
  });
}

export interface PostWorkoutPayload {
  share_to_strava: boolean;
  workout: {
    apple_watch: boolean;
    wearos_watch: boolean;
    biometrics: {
      heart_rate_samples: HeartRateSample[];
      total_calories: number;
    };
    description: string;
    start_time: number;
    end_time: number;
    exercises: CloneExercise[];
    is_biometrics_public: boolean;
    is_private: boolean;
    media: unknown[];
    routine_id: string | null;
    title: string;
    workout_id: string;
    trainer_program_id: string | null;
  };
}

export function buildClonePayload(
  v1: V1Workout,
  v2: V2Workout,
  startSec: number,
  endSec: number,
  hr: HeartRateSample[],
): PostWorkoutPayload {
  return {
    share_to_strava: false,
    workout: {
      // Both watch flags off — confirmed Hevy accepts biometrics either way.
      apple_watch: false,
      wearos_watch: false,
      biometrics: {
        heart_rate_samples: hr,
        total_calories: 0,
      },
      description: v1.description ?? '',
      start_time: startSec,
      end_time: endSec,
      exercises: mergeExercises(v1, v2),
      is_biometrics_public: true,
      is_private: false,
      media: [],
      // Hevy rejects empty strings here — must be null or a real UUID.
      routine_id: v1.routine_id ?? null,
      title: v1.title,
      // New workout id (must be a fresh UUID, not the original)
      workout_id: crypto.randomUUID(),
      trainer_program_id: v2.trainer_program_id ?? null,
    },
  };
}

async function createClone(
  payload: PostWorkoutPayload,
): Promise<{ status: number; body: unknown }> {
  const token = await ensureHevySession();
  const res = await axios.post(`${HEVY_BASE}/v2/workout`, payload, {
    headers: {
      ...MOBILE_HEADERS,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    timeout: 20_000,
    validateStatus: () => true, // we inspect status ourselves
  });
  return { status: res.status, body: res.data };
}

async function deleteOriginal(id: string): Promise<number> {
  const token = await ensureHevySession();
  const res = await axios.delete(`${HEVY_BASE}/workout/${id}`, {
    headers: {
      ...MOBILE_HEADERS,
      Authorization: `Bearer ${token}`,
    },
    timeout: 15_000,
  });
  return res.status;
}

// ============================================================================
// 6) HTTP handler — atomic pipeline with hard safety gate before delete
// ============================================================================

/**
 * Heavy work that happens AFTER we ack 200 to Hevy. Errors are logged but
 * not surfaced — Hevy already considers the webhook delivered.
 */
async function processWorkout(
  workoutId: string,
  bodyStartTime?: string | number,
  bodyEndTime?: string | number,
): Promise<void> {
  const startedAt = Date.now();

  // Hybrid GET — v1 has weights/reps/distances, v2 has rest_seconds /
  // completed_at / volume_doubling_enabled.
  const [v1, v2] = await Promise.all([
    getWorkoutV1(workoutId),
    getWorkoutV2(workoutId),
  ]);

  // Loop prevention: every clone we POST fires its own workout.created
  // webhook. Our clones always have HR samples; original (app-logged)
  // strength workouts never do. So skip anything that already has
  // biometrics — either it's our clone, or the user logged it with a
  // watch and HR enrichment is unneeded.
  const existingSampleCount = v2.biometrics?.heart_rate_samples?.length ?? 0;
  if (existingSampleCount > 0) {
    log('INFO', 'workout already has biometrics — skipping (loop guard)', {
      workoutId,
      existing_hr_samples: existingSampleCount,
    });
    return;
  }

  const startSec =
    toUnixSeconds(bodyStartTime) ?? toUnixSeconds(v1.start_time);
  const endSec = toUnixSeconds(bodyEndTime) ?? toUnixSeconds(v1.end_time);
  if (startSec == null || endSec == null) {
    throw new Error('Could not resolve workout start/end time');
  }
  log('INFO', 'workout window resolved', {
    workoutId,
    startSec,
    endSec,
    duration_min: ((endSec - startSec) / 60).toFixed(1),
  });

  const googleToken = await getGoogleAccessToken();
  const hrSamples = await fetchHeartRate(
    googleToken,
    toIsoUtc(startSec),
    toIsoUtc(endSec),
  );
  log('INFO', 'fetched HR samples', { count: hrSamples.length });

  if (hrSamples.length === 0) {
    log('WARN', 'no HR samples in window — skipping clone/delete', { workoutId });
    return;
  }

  const payload = buildClonePayload(v1, v2, startSec, endSec, hrSamples);

  // --- SAFETY GATE: clone must succeed before we delete the original ---
  let cloneResult: { status: number; body: unknown };
  try {
    cloneResult = await createClone(payload);
  } catch (err) {
    const ax = err as AxiosError;
    log('ERROR', 'clone POST threw — original PRESERVED', {
      workoutId,
      status: ax.response?.status,
      data: ax.response?.data,
      message: ax.message,
    });
    return;
  }

  if (cloneResult.status !== 200 && cloneResult.status !== 201) {
    log('ERROR', 'clone returned non-success — original PRESERVED', {
      workoutId,
      status: cloneResult.status,
      body: cloneResult.body,
    });
    return;
  }

  // Validate the response inline before trusting the 200. Hevy's POST
  // returns the full persisted workout — check that it has an id and the
  // expected HR sample count. Catches partial saves or silent field
  // stripping without an extra request.
  const cloneBody = cloneResult.body as
    | {
        id?: string;
        biometrics?: { heart_rate_samples?: unknown[] };
      }
    | undefined;
  const newId = cloneBody?.id;
  const persistedSamples = cloneBody?.biometrics?.heart_rate_samples?.length ?? 0;
  const expectedSamples = hrSamples.length;
  if (!newId || persistedSamples !== expectedSamples) {
    log('ERROR', 'clone response failed validation — original PRESERVED', {
      workoutId,
      status: cloneResult.status,
      new_id: newId ?? null,
      expected_samples: expectedSamples,
      persisted_samples: persistedSamples,
    });
    return;
  }

  log('INFO', 'clone created and validated', {
    workoutId,
    status: cloneResult.status,
    new_id: newId,
    samples: persistedSamples,
  });
  // ---------------------------------------------------------------------

  if (SKIP_DELETE) {
    log('WARN', 'SKIP_DELETE=true — original preserved, you now have a duplicate', {
      workoutId,
      hr_samples: hrSamples.length,
      duration_ms: Date.now() - startedAt,
    });
    return;
  }

  const delStatus = await deleteOriginal(workoutId);
  log('INFO', 'original deleted', {
    workoutId,
    delete_status: delStatus,
    hr_samples: hrSamples.length,
    duration_ms: Date.now() - startedAt,
  });
}

http('hevyWebhook', async (req: Request, res: Response): Promise<void> => {
  // Pre-ack phase: anything that fails here returns an HTTP error to Hevy.
  // Must finish well within Hevy's 5s budget.
  try {
    assertEnv();

    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    // Shared-secret check. Hevy sends whatever the user configured in their
    // webhook UI as the Authorization header — exact-match required.
    if (WEBHOOK_AUTH_HEADER) {
      const got = req.headers.authorization ?? '';
      if (got !== WEBHOOK_AUTH_HEADER) {
        log('WARN', 'rejected — auth header mismatch', {
          got_prefix: got.slice(0, 16) || '(empty)',
        });
        res.status(401).send('Unauthorized');
        return;
      }
    }

    const body = (req.body ?? {}) as WebhookBody;
    log('INFO', 'webhook received', { body });

    const workoutId = extractWorkoutId(body);

    // Ack Hevy immediately. Cloud Run keeps the instance alive while the
    // handler is still executing, so the await below continues to run.
    res.status(200).json({ status: 'accepted', workoutId });

    // Post-ack phase: heavy work. Errors logged only.
    try {
      await processWorkout(workoutId, body.start_time, body.end_time);
    } catch (err) {
      const e = err as Error & {
        response?: { status?: number; data?: unknown };
      };
      log('ERROR', 'post-ack processing failed', {
        workoutId,
        message: e.message,
        status: e.response?.status,
        data: e.response?.data,
        stack: e.stack,
      });
    }
  } catch (err) {
    const e = err as Error;
    log('ERROR', 'pre-ack error', { message: e.message, stack: e.stack });
    if (!res.headersSent) {
      res.status(500).json({ status: 'error', message: e.message });
    }
  }
});
