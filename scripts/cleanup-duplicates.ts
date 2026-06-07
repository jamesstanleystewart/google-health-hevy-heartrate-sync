// Cleanup script for loop-generated duplicate workouts.
//
// Identifies workouts that share the exact same (title, start_time), keeps
// the OLDEST one in each group (by created_at — the user's actual logged
// workout), and deletes the rest via Hevy's v2 mobile DELETE endpoint.
//
// Dry-run by default:
//   npm run cleanup
//
// To actually delete:
//   APPLY=true npm run cleanup
//
// Reads HEVY_API_KEY (v1 read) + HEVY_ACCESS_TOKEN (v2 delete) from .env.

import axios from 'axios';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

const HEVY_BASE = 'https://api.hevyapp.com';
const MOBILE_HEADERS = {
  'X-Api-Key': 'klean_kanteen_insulated',
  'Hevy-App-Version': '2.5.6',
  'Hevy-App-Build': '1819922',
  'Hevy-Platform': 'android 36',
};
const WEB_API_KEY = 'with_great_power';

const APPLY = (process.env.APPLY ?? '').toLowerCase() === 'true';
const BUCKET = process.env.HEVY_TOKEN_BUCKET ?? '';
const OBJECT = process.env.HEVY_TOKEN_OBJECT ?? 'hevy-tokens.json';

interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

let session: Session = {
  access_token: process.env.HEVY_ACCESS_TOKEN ?? '',
  refresh_token: process.env.HEVY_REFRESH_TOKEN ?? '',
  expires_at: process.env.HEVY_EXPIRES_AT ?? '',
};

function loadFromGcs(): Session | null {
  if (!BUCKET) return null;
  try {
    const out = execSync(`gcloud storage cat gs://${BUCKET}/${OBJECT}`, { encoding: 'utf8' });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

async function refreshSession(): Promise<void> {
  const { data } = await axios.post<Session>(
    `${HEVY_BASE}/auth/refresh_token`,
    { refresh_token: session.refresh_token },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': WEB_API_KEY,
        Authorization: `Bearer ${session.access_token}`,
      },
      timeout: 10_000,
    },
  );
  session = data;
  // CRITICAL: write back to GCS so the deployed function keeps working.
  // Without this, the script eats refresh tokens and breaks the chain.
  if (BUCKET) saveToGcs(session);
  console.log(`  [token refreshed; new expires_at=${data.expires_at}]`);
}

function saveToGcs(s: Session): void {
  const tmp = `/tmp/hevy-tokens-${process.pid}.json`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  try {
    execSync(`gcloud storage cp ${tmp} gs://${BUCKET}/${OBJECT} --quiet`, {
      stdio: 'pipe',
    });
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function deleteWithRetry(id: string): Promise<number> {
  let res = await axios.delete(`${HEVY_BASE}/workout/${id}`, {
    headers: { ...MOBILE_HEADERS, Authorization: `Bearer ${session.access_token}` },
    timeout: 15_000,
    validateStatus: () => true,
  });
  if (res.status === 401 || res.status === 403) {
    await refreshSession();
    res = await axios.delete(`${HEVY_BASE}/workout/${id}`, {
      headers: { ...MOBILE_HEADERS, Authorization: `Bearer ${session.access_token}` },
      timeout: 15_000,
      validateStatus: () => true,
    });
  }
  return res.status;
}

async function listAllWorkouts(apiKey: string) {
  const all: Array<{ id: string; title: string; start_time: string; created_at: string }> = [];
  let page = 1;
  while (true) {
    const { data } = await axios.get(`${HEVY_BASE}/v1/workouts`, {
      params: { page, pageSize: 10 },
      headers: { 'api-key': apiKey },
    });
    if (!data?.workouts?.length) break;
    for (const w of data.workouts) {
      all.push({
        id: w.id,
        title: w.title ?? '',
        start_time: String(w.start_time ?? ''),
        created_at: String(w.created_at ?? ''),
      });
    }
    if (page >= (data.page_count ?? 1)) break;
    page++;
  }
  return all;
}

async function main() {
  const apiKey = need('HEVY_API_KEY');

  // Prefer GCS — it has the latest rotated tokens written by the deployed
  // function. Fall back to env vars (initial bootstrap state).
  const gcs = loadFromGcs();
  if (gcs) {
    session = gcs;
    console.log(`Using session from gs://${BUCKET}/${OBJECT} (expires_at=${gcs.expires_at})`);
  } else {
    if (!session.access_token) {
      console.error('No HEVY_ACCESS_TOKEN in env and GCS read failed');
      process.exit(1);
    }
    console.log('Using session from env vars');
  }

  console.log('Fetching all workouts...');
  const all = await listAllWorkouts(apiKey);
  console.log(`Total workouts: ${all.length}`);

  // Group by (title, start_time)
  const groups = new Map<string, typeof all>();
  for (const w of all) {
    const key = `${w.title}\t${w.start_time}`;
    const arr = groups.get(key) ?? [];
    arr.push(w);
    groups.set(key, arr);
  }

  // Identify duplicates
  const toDelete: Array<{ id: string; title: string }> = [];
  const toKeep: Array<{ id: string; title: string; created_at: string }> = [];

  for (const [, ws] of groups) {
    if (ws.length < 2) continue;
    // Sort by created_at ascending — keep the oldest
    ws.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const keeper = ws[0];
    toKeep.push({ id: keeper.id, title: keeper.title, created_at: keeper.created_at });
    for (let i = 1; i < ws.length; i++) {
      toDelete.push({ id: ws[i].id, title: ws[i].title });
    }
  }

  console.log(`\nDuplicate groups: ${toKeep.length}`);
  console.log(`Keepers (oldest in each group):`);
  for (const k of toKeep) {
    console.log(`  ${k.id}  ${k.created_at}  ${k.title}`);
  }
  console.log(`\nTo delete: ${toDelete.length} workouts`);

  if (!APPLY) {
    console.log('\n[DRY RUN] set APPLY=true to actually delete.');
    return;
  }

  console.log('\nDeleting (rate-limited, ~3 req/sec, refreshes session on 401)...');
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < toDelete.length; i++) {
    const w = toDelete[i];
    const status = await deleteWithRetry(w.id);
    if (status === 200 || status === 204) {
      ok++;
    } else {
      fail++;
      console.log(`  FAIL ${w.id} status=${status}`);
    }
    if ((i + 1) % 25 === 0 || i === toDelete.length - 1) {
      console.log(`  progress: ${i + 1}/${toDelete.length}  ok=${ok}  fail=${fail}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`\nDone. ok=${ok} fail=${fail}`);
}

main().catch((e) => {
  console.error('Unhandled:', e);
  process.exit(1);
});
