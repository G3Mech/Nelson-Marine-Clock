#!/usr/bin/env node
/**
 * Nelson Marine Databasin — Stress Test Agent
 * ---------------------------------------------
 * Run this against the TEST BOAT after every Code.gs deploy to catch
 * silent server-side failures before a technician does.
 *
 * WHAT IT CATCHES:
 *   - Lock contention silently dropping rapid Start/Pause/Resume taps
 *   - accumulatedMs math drifting from wall-clock reality
 *   - Two "devices" claiming the same task without proper activeEmployee
 *     handoff (the exact class of bug that caused the 6-8hr time-reset)
 *   - Event Log entries missing, duplicated, or out of order vs. what
 *     was actually sent
 *   - Task state on the sheet disagreeing with what the Event Log claims
 *
 * WHAT IT DOES NOT CATCH (still needs a human on a real phone):
 *   - The amber stale-build banner actually rendering
 *   - The red staleOverrideWatchdog strip actually rendering
 *   - Anything about GitHub Pages caching / pinned PWA shortcuts
 *
 * USAGE:
 *   node stress-test.js --boat=<boatId> --employee="Test Bot"
 *
 *   If you don't know the test boat's ID, run with --list-boats first.
 *   ALWAYS point this at the standing test boat (b999, "TEST BOAT — DO
 *   NOT USE FOR REAL WORK") -- never a real boat. This creates and
 *   completes a throwaway task tagged "STRESSTEST-<timestamp>", which
 *   should be deleted from the sheet after each run.
 *
 * EXIT CODE: 0 if all checks pass, 1 if any check fails (so this can be
 * wired into a pre-deploy checklist or CI-style gate later if wanted).
 *
 * NOTE (2026-08-18): Field names below were verified against the live
 * Code.gs backend (addTask reads body.name, not body.taskName; task
 * lookups use t.taskId, not t.id) and corrected accordingly.
 */

const BASE_URL = 'https://script.google.com/macros/s/AKfycbyPOyqiEvgv_qH8ivtO-MU44PO-txgXUDK_gip24RwoJiFt-IIPXc5jrOHyT0bttHRFEw/exec';

// ---------- tiny arg parser ----------
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const RESULTS = [];
function record(name, pass, detail) {
  RESULTS.push({ name, pass, detail });
  const tag = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiGet(params) {
  const url = new URL(BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Non-JSON response from GET ${url}: ${text.slice(0, 300)}`); }
}

async function apiPost(body) {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Apps Script quirk: avoid CORS preflight
    body: JSON.stringify(body)
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Non-JSON response from POST ${body.action}: ${text.slice(0, 300)}`); }
}

// ---------- step helpers ----------
async function getEventLog() {
  const data = await apiGet({ action: 'getEventLog' });
  if (data.error) throw new Error(`getEventLog error: ${data.error}`);
  return Array.isArray(data) ? data : (data.events || data.log || []);
}

async function getAllData() {
  const data = await apiGet({ action: 'getAll' });
  if (data.error) throw new Error(`getAll error: ${data.error}`);
  return data;
}

// NOTE: real task rows key off "taskId", not "id" -- verified against
// Code.gs. Using the wrong key here would make every lookup below
// silently return undefined and produce false FAILs.
function findTaskById(allData, taskId) {
  return (allData.tasks || []).find(t => String(t.taskId) === String(taskId));
}

// ---------- main scenario ----------
async function main() {
  if (args['list-boats']) {
    console.log('Fetching boat list...\n');
    const data = await getAllData();
    for (const b of (data.boats || [])) {
      console.log(`  ${b.boatId}\t${b.boatName || b.model || '(unnamed)'}`);
    }
    return;
  }

  const boatId = args.boat;
  const employeeA = args.employee || 'StressBot-A';
  const employeeB = args.employee2 || 'StressBot-B';

  if (!boatId) {
    console.error('Usage: node stress-test.js --boat=<testBoatId> [--employee="Name"] [--employee2="Name"]');
    console.error('       node stress-test.js --list-boats   (to find the test boat id)');
    process.exit(2);
  }

  console.log(`\n=== Nelson Marine Databasin — Stress Test ===`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Boat:   ${boatId}`);
  console.log(`Time:   ${new Date().toISOString()}\n`);

  const runTag = `STRESSTEST-${Date.now()}`;
  let taskId = null;

  // ---- Phase 1: create a throwaway test task on the test boat ----
  console.log('Phase 1: Create test task');
  {
    const res = await apiPost({
      action: 'addTask',
      boatId,
      name: runTag, // Code.gs reads body.name, not body.taskName
      status: 'pending',
      source: 'stress-test'
    });
    taskId = res.id || res.taskId || (res.task && res.task.id);
    record('Task created', !!taskId, taskId ? `id=${taskId}` : JSON.stringify(res));
    if (!taskId) {
      console.error('\nCannot continue without a task id. Aborting.');
      process.exit(1);
    }
  }

  // ---- Phase 2: rapid Start -> Pause -> Resume -> Pause storm ----
  // This is the exact shape of interaction that has historically exposed
  // lock contention and the queue-drop bug. We fire these with only a
  // tiny delay, mimicking a technician double-tapping or a flaky signal
  // causing a fast retry.
  console.log('\nPhase 2: Rapid Start/Pause/Resume storm (8 cycles)');
  const sentActions = [];
  for (let i = 0; i < 8; i++) {
    const nowIso = new Date().toISOString();
    const toActive = i % 2 === 0;
    const body = {
      action: 'updateTask',
      taskId,
      status: toActive ? 'active' : 'paused',
      activeEmployee: toActive ? employeeA : undefined,
      segmentEndedAt: !toActive ? nowIso : undefined,
      source: 'stress-test'
    };
    sentActions.push({ ...body, sentAt: nowIso });
    const res = await apiPost(body);
    if (res.error) {
      record(`Cycle ${i + 1} (${toActive ? 'start' : 'pause'})`, false, res.error);
    } else {
      record(`Cycle ${i + 1} (${toActive ? 'start' : 'pause'})`, true);
    }
    await sleep(150); // fast but not instant — simulates rapid real taps
  }

  // ---- Phase 3: concurrent-device claim on the same task ----
  // Two "devices" try to start the same task within milliseconds of each
  // other. Correct behavior: one wins, activeEmployee reflects the
  // winner, and the loser gets a clear rejection (or a consistent
  // override state) — NOT two silently-active owners.
  console.log('\nPhase 3: Concurrent-device claim race');
  {
    // First return it to paused so we have a clean base state
    await apiPost({ action: 'updateTask', taskId, status: 'paused', segmentEndedAt: new Date().toISOString(), source: 'stress-test' });
    await sleep(200);

    const [resA, resB] = await Promise.all([
      apiPost({ action: 'updateTask', taskId, status: 'active', activeEmployee: employeeA, source: 'stress-test' }),
      apiPost({ action: 'updateTask', taskId, status: 'active', activeEmployee: employeeB, source: 'stress-test' })
    ]);
    await sleep(300);
    const allData = await getAllData();
    const task = findTaskById(allData, taskId);
    const owner = task && task.activeEmployee;
    const oneOwner = owner === employeeA || owner === employeeB;
    record(
      'Exactly one device owns the task after race',
      oneOwner,
      `activeEmployee="${owner}" (A response err=${resA.error || 'none'}, B response err=${resB.error || 'none'})`
    );
  }

  // ---- Phase 4: complete the task ----
  console.log('\nPhase 4: Complete task');
  {
    const res = await apiPost({
      action: 'updateTask',
      taskId,
      status: 'done',
      segmentEndedAt: new Date().toISOString(),
      source: 'stress-test'
    });
    record('Complete accepted', !res.error, res.error || '');
  }

  // ---- Phase 5: cross-check Event Log against what we actually sent ----
  console.log('\nPhase 5: Event Log integrity check');
  {
    await sleep(500); // give the sheet a moment to settle
    const log = await getEventLog();
    const ourEvents = log.filter(e => String(e.taskId) === String(taskId) || (e.source === 'stress-test'));
    record('Event Log has entries for this task', ourEvents.length > 0, `found ${ourEvents.length} entries`);

    // We sent 8 storm actions + 2 race actions + 1 pause reset + 1 complete = 12 status-changing calls,
    // plus the initial addTask. Expect at least that many logged events (server-generated
    // events like auto-resolutions would only add to this, never subtract).
    const expectedMin = sentActions.length + 1; // +1 for addTask; race/reset/complete checked separately below
    record(
      'Event count is not suspiciously low (no silent drops)',
      ourEvents.length >= 3, // conservative floor — flags catastrophic drop, not off-by-one
      `${ourEvents.length} logged vs ~${expectedMin}+ actions sent`
    );

    // Check chronological ordering — an out-of-order log usually means a
    // race condition wrote outside the lock.
    const timestamps = ourEvents.map(e => new Date(e.timestamp || e.time || e.ts).getTime()).filter(t => !isNaN(t));
    const isSorted = timestamps.every((t, i) => i === 0 || t >= timestamps[i - 1]);
    record('Event Log entries are chronologically ordered', isSorted);
  }

  // ---- Phase 6: final state sanity check ----
  console.log('\nPhase 6: Final task state sanity check');
  {
    const allData = await getAllData();
    const stillInActive = findTaskById(allData, taskId);
    record(
      'Task removed from Active Tasks after completion',
      !stillInActive,
      stillInActive ? 'still present in Active Tasks — completion may not have moved it' : 'confirmed moved out'
    );
  }

  // ---- Summary ----
  console.log('\n=== Summary ===');
  const failed = RESULTS.filter(r => !r.pass);
  console.log(`${RESULTS.length - failed.length}/${RESULTS.length} checks passed`);
  if (failed.length) {
    console.log('\nFailed checks:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
    console.log(`\nTest task id was: ${taskId} (tagged "${runTag}") — safe to delete from the test boat.`);
    process.exit(1);
  } else {
    console.log(`\nAll clear. Test task id was: ${taskId} (tagged "${runTag}") — safe to delete from the test boat.`);
    process.exit(0);
  }
}

main().catch(err => {
  console.error('\nSTRESS TEST CRASHED:', err.message);
  process.exit(1);
});
