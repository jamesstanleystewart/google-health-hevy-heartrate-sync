// Local pipeline harness. Default mode is read-only (no mutation anywhere).
// Steps:
//   google-token  refresh Google OAuth
//   hevy-v1       GET /v1/workouts/{id} (full structure)
//   google-hr     GET /v4/.../heart-rate/dataPoints for the workout window
//   hevy-v2       GET /workout/{id} (mobile API, enrichment data)
//   build         construct the clone PostWorkout payload → scripts/last-payload.json
//   post          POST the clone to Hevy (CREATES a duplicate workout)
//                 ⚠️ only fires when LIVE=true. Never deletes the original.
//
// Usage:
//   npm run dry-run                          # all read-only steps + build
//   STEPS=build npm run dry-run              # just rebuild payload
//   LIVE=true STEPS=...,post npm run dry-run # actually push the clone
//
// Env vars consumed (from .env via tsx --env-file):
//   HEVY_API_KEY, HEVY_ACCESS_TOKEN, HEVY_REFRESH_TOKEN,
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
//   TEST_WORKOUT_ID, [LIVE]

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import axios, { AxiosError } from 'axios';

import {
  buildClonePayload,
  type HeartRateSample,
  type PostWorkoutPayload,
  type V1Workout,
  type V2Workout,
} from '../src/index';

const HEVY_BASE = 'https://api.hevyapp.com';
const HEALTH_HR_URL =
  'https://health.googleapis.com/v4/users/me/dataTypes/heart-rate/dataPoints';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MOBILE_HEADERS = {
  'X-Api-Key': 'klean_kanteen_insulated',
  'Hevy-App-Version': '2.5.6',
  'Hevy-App-Build': '1819922',
  'Hevy-Platform': 'android 36',
};
const WEB_API_KEY = 'with_great_power';

const ALL_STEPS = [
  'google-token',
  'hevy-v1',
  'google-hr',
  'hevy-v2',
  'build',
  'post',
] as const;
type Step = (typeof ALL_STEPS)[number];

const requestedSteps = (process.env.STEPS?.split(',').map((s) => s.trim()) ??
  // Default: everything except `post`
  ALL_STEPS.filter((s) => s !== 'post')) as Step[];

const LIVE = (process.env.LIVE ?? '').toLowerCase() === 'true';

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function header(label: string): void {
  console.log(`\n\x1b[1;36m── ${label} ──\x1b[0m`);
}

function ok(msg: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}

function fail(msg: string, err?: unknown): never {
  console.log(`\x1b[31m✗\x1b[0m ${msg}`);
  if (err) {
    const ax = err as AxiosError;
    if (ax.response) {
      console.log('  status:', ax.response.status);
      console.log('  body:', JSON.stringify(ax.response.data, null, 2));
    } else {
      console.log('  err:', (err as Error).message);
    }
  }
  process.exit(1);
}

function toUnixSec(t: string | number | null | undefined): number {
  if (t == null) fail('missing time');
  if (typeof t === 'number') return t < 1e12 ? Math.floor(t) : Math.floor(t / 1000);
  return Math.floor(new Date(t).getTime() / 1000);
}

// ============================================================================
// Steps
// ============================================================================

async function step_googleToken(): Promise<string> {
  header('Step 1: Google OAuth refresh');
  const id = need('GOOGLE_CLIENT_ID');
  const secret = need('GOOGLE_CLIENT_SECRET');
  const rt = need('GOOGLE_REFRESH_TOKEN');

  try {
    const body = new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: rt,
      grant_type: 'refresh_token',
    });
    const { data } = await axios.post<{ access_token?: string; expires_in?: number; scope?: string }>(
      GOOGLE_TOKEN_URL,
      body,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
    );
    if (!data.access_token) fail('No access_token in response');
    ok(`access_token (${data.access_token!.length} chars), expires in ${data.expires_in}s`);
    if (data.scope) console.log('  scope:', data.scope);
    return data.access_token!;
  } catch (err) {
    fail('Google OAuth refresh failed', err);
  }
}

async function step_hevyV1(workoutId: string): Promise<V1Workout> {
  header(`Step 2: Hevy v1 GET /workouts/${workoutId}`);
  const apiKey = need('HEVY_API_KEY');
  try {
    const { data } = await axios.get(`${HEVY_BASE}/v1/workouts/${workoutId}`, {
      headers: { 'api-key': apiKey },
      timeout: 15_000,
    });
    const w = (data.workout ?? data) as V1Workout;
    const startSec = toUnixSec(w.start_time);
    const endSec = toUnixSec(w.end_time);
    ok(`"${w.title}" — ${w.exercises?.length ?? 0} exercises`);
    console.log(`  window: ${new Date(startSec * 1000).toISOString()} → ${new Date(endSec * 1000).toISOString()}`);
    console.log(`  duration: ${((endSec - startSec) / 60).toFixed(1)} min`);
    return w;
  } catch (err) {
    fail('Hevy v1 GET failed', err);
  }
}

async function step_googleHr(
  accessToken: string,
  startIso: string,
  endIso: string,
): Promise<HeartRateSample[]> {
  header(`Step 3: Google Health v4 HR fetch (${startIso} → ${endIso})`);
  const filter =
    `heart_rate.sample_time.physical_time >= "${startIso}" ` +
    `AND heart_rate.sample_time.physical_time < "${endIso}"`;

  const samples: HeartRateSample[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  try {
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
      pages++;
    } while (pageToken);

    samples.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    ok(`fetched ${samples.length} HR samples across ${pages} page(s)`);
    if (samples.length > 0) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      console.log(`  first: ${new Date(first.timestamp_ms).toISOString()}  bpm=${first.bpm}`);
      console.log(`  last:  ${new Date(last.timestamp_ms).toISOString()}  bpm=${last.bpm}`);
    } else {
      console.log('  ⚠️  No samples — Google Health has no HR data in this window.');
    }
    return samples;
  } catch (err) {
    fail('Google Health HR fetch failed', err);
  }
}

async function step_hevyV2(workoutId: string): Promise<V2Workout> {
  header(`Step 4: Hevy v2 mobile auth + GET /workout/${workoutId}`);
  const accessToken = need('HEVY_ACCESS_TOKEN');

  try {
    const { data } = await axios.get(`${HEVY_BASE}/workout/${workoutId}`, {
      headers: { ...MOBILE_HEADERS, Authorization: `Bearer ${accessToken}` },
      timeout: 15_000,
    });
    const w = (data.workout ?? data) as V2Workout;
    ok(`v2 GET returned ${w.exercises?.length ?? 0} exercises`);
    if (w.exercises?.[0]) {
      console.log('  first exercise rest_seconds:', w.exercises[0].rest_seconds);
    }
    return w;
  } catch (err) {
    const ax = err as AxiosError;
    if (ax.response?.status === 401 || ax.response?.status === 403) {
      console.log('  401/403 — access token is stale. Trying refresh...');
      try {
        const refreshToken = need('HEVY_REFRESH_TOKEN');
        const { data } = await axios.post(
          `${HEVY_BASE}/auth/refresh_token`,
          { refresh_token: refreshToken },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': WEB_API_KEY,
              Authorization: `Bearer ${accessToken}`,
            },
            timeout: 10_000,
          },
        );
        const outPath = resolve(__dirname, 'new-tokens.env');
        writeFileSync(
          outPath,
          `HEVY_ACCESS_TOKEN=${data.access_token}\n` +
            `HEVY_REFRESH_TOKEN=${data.refresh_token}\n` +
            `HEVY_EXPIRES_AT=${data.expires_at}\n`,
        );
        ok('refresh succeeded');
        console.log(`  wrote new tokens → ${outPath}`);
        console.log('  paste the three lines into .env, then re-run');
        process.exit(0);
      } catch (refreshErr) {
        fail('Refresh also failed — re-extract cookie from app.hevyapp.com', refreshErr);
      }
    }
    fail('Hevy v2 GET failed', err);
  }
}

function step_build(
  v1: V1Workout,
  v2: V2Workout,
  startSec: number,
  endSec: number,
  hr: HeartRateSample[],
): PostWorkoutPayload {
  header('Step 5: Build clone PostWorkout payload');
  const payload = buildClonePayload(v1, v2, startSec, endSec, hr);
  const outPath = resolve(__dirname, 'last-payload.json');
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  const sizeKb = (JSON.stringify(payload).length / 1024).toFixed(1);
  ok(`built payload — ${payload.workout.exercises.length} exercises, ${payload.workout.biometrics.heart_rate_samples.length} HR samples, ${sizeKb} KB`);
  console.log(`  wrote: ${outPath}`);
  console.log(`  inspect with: jq '.workout | {title, start_time, end_time, exercises: (.exercises|length), hr_samples: (.biometrics.heart_rate_samples|length)}' ${outPath}`);
  return payload;
}

async function step_post(payload: PostWorkoutPayload): Promise<void> {
  header('Step 6: LIVE POST clone → Hevy /v2/workout');
  if (!LIVE) {
    console.log('  ⚠️  LIVE=true not set — skipping. To actually POST, run:');
    console.log('  LIVE=true npm run dry-run');
    return;
  }
  const accessToken = need('HEVY_ACCESS_TOKEN');
  console.log('  POSTing clone (original will NOT be deleted)...');
  try {
    const res = await axios.post(`${HEVY_BASE}/v2/workout`, payload, {
      headers: {
        ...MOBILE_HEADERS,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      timeout: 20_000,
      validateStatus: () => true,
    });
    if (res.status !== 200 && res.status !== 201) {
      console.log('  ✗ unexpected status:', res.status);
      console.log('  body:', JSON.stringify(res.data, null, 2));
      process.exit(1);
    }
    ok(`Hevy accepted the clone (status ${res.status})`);
    console.log('  body:', JSON.stringify(res.data, null, 2));
    console.log('\n  Check app.hevyapp.com — you should now have TWO workouts with the same title.');
    console.log('  Inspect the new one for the heart-rate stream, then manually delete whichever you don\'t want.');
  } catch (err) {
    fail('Hevy clone POST failed', err);
  }
}

// ============================================================================
// Orchestration
// ============================================================================

async function main() {
  const wantedSet = new Set(requestedSteps);
  console.log('Steps:', [...wantedSet].join(', '));
  console.log(`LIVE: ${LIVE}`);

  // Dependencies between steps:
  //   build needs: v1, v2, hr, googleToken (indirectly), startSec/endSec
  //   post  needs: build
  // Auto-enable upstream steps so user can just say STEPS=post.
  if (wantedSet.has('post')) wantedSet.add('build');
  if (wantedSet.has('build')) {
    wantedSet.add('hevy-v1');
    wantedSet.add('hevy-v2');
    wantedSet.add('google-hr');
  }
  if (wantedSet.has('google-hr')) wantedSet.add('google-token');

  let googleToken: string | null = null;
  let v1: V1Workout | null = null;
  let v2: V2Workout | null = null;
  let hr: HeartRateSample[] | null = null;
  let payload: PostWorkoutPayload | null = null;

  if (wantedSet.has('google-token')) {
    googleToken = await step_googleToken();
  }

  if (wantedSet.has('hevy-v1')) {
    const workoutId = need('TEST_WORKOUT_ID');
    v1 = await step_hevyV1(workoutId);
  }

  if (wantedSet.has('google-hr')) {
    if (!googleToken) fail('google-hr requires google-token');
    if (v1) {
      hr = await step_googleHr(
        googleToken,
        new Date(toUnixSec(v1.start_time) * 1000).toISOString(),
        new Date(toUnixSec(v1.end_time) * 1000).toISOString(),
      );
    } else {
      // No workout context — smoke test with last hour
      const end = Math.floor(Date.now() / 1000);
      hr = await step_googleHr(
        googleToken,
        new Date((end - 3600) * 1000).toISOString(),
        new Date(end * 1000).toISOString(),
      );
    }
  }

  if (wantedSet.has('hevy-v2')) {
    const workoutId = need('TEST_WORKOUT_ID');
    v2 = await step_hevyV2(workoutId);
  }

  if (wantedSet.has('build')) {
    if (!v1 || !v2 || !hr) fail('build requires v1, v2, and hr');
    if (hr.length === 0) {
      console.log('\n⚠️  Refusing to build payload — 0 HR samples means an empty biometrics array. Pick a workout window with HR data.');
      process.exit(1);
    }
    payload = step_build(v1, v2, toUnixSec(v1.start_time), toUnixSec(v1.end_time), hr);
  }

  if (wantedSet.has('post')) {
    if (!payload) fail('post requires a built payload');
    await step_post(payload);
  }

  console.log('\n\x1b[1;32mDone.\x1b[0m');
}

main().catch((e) => {
  console.error('\n\x1b[31mUnhandled:\x1b[0m', e);
  process.exit(1);
});
