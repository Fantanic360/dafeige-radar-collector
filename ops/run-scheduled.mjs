#!/usr/bin/env node
/**
 * Scheduled entry point.
 *
 * The collector decides "is this the 10:00 edition round?" from the *planned* slot, not
 * from the wall clock at startup — a run that begins at 10:00:41 must still be the edition
 * round, and a run that begins at 10:07 because the machine was asleep must not silently
 * become a 8-target supplementary round.
 *
 * So the scheduler calls this wrapper, and it derives the planned slot from
 * config/policy.json. Every ops example (cron / launchd / systemd) points here.
 *
 *   node ops/run-scheduled.mjs            # normal run
 *   node ops/run-scheduled.mjs --dry-run  # same, without writing
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BEIJING_OFFSET_MS = 8 * 3600_000;

function loadSchedule() {
  const file = path.join(ROOT, 'config/policy.json');
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rounds = policy?.schedule?.rounds?.length ? policy.schedule.rounds : ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'];
  const editionHour = policy?.schedule?.editionHour ?? 10;
  return { rounds, editionHour };
}

/** Latest planned slot at or before now, within a grace window; else the nearest slot. */
function plannedSlot(now, rounds, { graceMinutes = 90 } = {}) {
  const beijing = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const y = beijing.getUTCFullYear();
  const m = beijing.getUTCMonth();
  const d = beijing.getUTCDate();

  const candidates = [];
  for (const dayOffset of [-1, 0, 1]) {
    for (const round of rounds) {
      const [hh, mm] = round.split(':').map(Number);
      // Build the slot as a Beijing wall-clock time, then convert back to UTC.
      const utcMs = Date.UTC(y, m, d + dayOffset, hh, mm) - BEIJING_OFFSET_MS;
      candidates.push({ iso: new Date(utcMs).toISOString(), ms: utcMs, round });
    }
  }

  const past = candidates.filter((c) => c.ms <= now.getTime()).sort((a, b) => b.ms - a.ms);
  const best = past[0];
  if (best && now.getTime() - best.ms <= graceMinutes * 60_000) return best;

  // Fired far outside any slot (manual run, long outage): use the closest slot so the
  // round type is still explicit instead of silently degrading to "supplementary".
  const nearest = candidates.sort((a, b) => Math.abs(a.ms - now.getTime()) - Math.abs(b.ms - now.getTime()))[0];
  return nearest;
}

const { rounds, editionHour } = loadSchedule();
const slot = plannedSlot(new Date(), rounds);
const edition = Number(slot.round.split(':')[0]) === Number(editionHour);

const passthrough = process.argv.slice(2).filter((a) => a !== '--scheduled-for');
const args = ['src/cli.mjs', 'run', '--scheduled-for', slot.iso, ...passthrough];

process.stderr.write(
  `${new Date().toISOString()} run-scheduled slot=${slot.iso} (${slot.round} 北京) edition=${edition}\n`,
);

try {
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
} catch (err) {
  process.stderr.write(`run-scheduled failed: ${err.status ?? err.message}\n`);
  process.exit(err.status || 1);
}
