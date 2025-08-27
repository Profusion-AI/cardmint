#!/usr/bin/env tsx
/**
 * Simple gamepad detector for Fedora: resolves a controller's event device
 * by scanning /dev/input/by-id for *event-joystick symlinks. Designed to
 * work with 8BitDo Ultimate 2C across XInput/DInput/Switch modes.
 *
 * Usage:
 *   tsx scripts/linux/gamepad-detect.ts [--watch] [--match <substr>]
 *
 * Prints a single READY/WAITING line with JSON details. With --watch, it
 * re-emits on connect/disconnect changes.
 */
import fs from 'fs';
import path from 'path';

type Detected = {
  status: 'READY' | 'WAITING';
  when: string;
  byId?: string;
  eventPath?: string;
  realEventPath?: string;
  mode?: 'xinput' | 'dinput' | 'switch' | 'unknown';
};

const BY_ID_DIR = '/dev/input/by-id';

function now() {
  return new Date().toISOString();
}

function guessMode(name: string): Detected['mode'] {
  const n = name.toLowerCase();
  if (n.includes('xbox') || n.includes('microsoft')) return 'xinput';
  if (n.includes('nintendo') || n.includes('switch')) return 'switch';
  if (n.includes('8bitdo')) return 'dinput';
  return 'unknown';
}

function listById(): string[] {
  try {
    return fs.readdirSync(BY_ID_DIR).map(f => path.join(BY_ID_DIR, f));
  } catch {
    return [];
  }
}

function resolveCandidate(matchSubstr?: string): Detected {
  const entries = listById().filter(p => p.endsWith('event-joystick'));
  let filtered = entries;
  if (matchSubstr) {
    const m = matchSubstr.toLowerCase();
    filtered = entries.filter(p => path.basename(p).toLowerCase().includes(m));
  }

  const best = filtered[0] || entries[0];
  if (!best) return { status: 'WAITING', when: now() };

  let realPath = '';
  try {
    const link = fs.readlinkSync(best);
    realPath = path.resolve(path.dirname(best), link);
  } catch {}

  return {
    status: 'READY',
    when: now(),
    byId: best,
    eventPath: best,
    realEventPath: realPath || undefined,
    mode: guessMode(path.basename(best)),
  };
}

function printStatus(det: Detected) {
  if (det.status === 'WAITING') {
    console.log(`WAITING ${JSON.stringify({ when: det.when })}`);
  } else {
    console.log(
      `READY ${JSON.stringify({ when: det.when, byId: det.byId, eventPath: det.eventPath, realEventPath: det.realEventPath, mode: det.mode })}`,
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  const watch = args.includes('--watch');
  const matchIdx = args.indexOf('--match');
  const match = matchIdx >= 0 ? args[matchIdx + 1] : undefined;

  let lastSig = '';
  function emit() {
    const det = resolveCandidate(match);
    const sig = JSON.stringify(det);
    if (sig !== lastSig) {
      lastSig = sig;
      printStatus(det);
    }
  }

  emit();
  if (watch) {
    try {
      fs.watch(BY_ID_DIR, { persistent: true }, () => {
        // Delay slightly to allow udev to finish creating links
        setTimeout(emit, 150);
      });
    } catch {
      // Directory might not exist until a device is connected; poll as fallback
      setInterval(emit, 1000);
    }
  }
}

main();

