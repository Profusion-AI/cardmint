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
  keyboardById?: string;
  keyboardEventPath?: string;
  realKeyboardEventPath?: string;
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

function parseInputDevices(): { joystick?: string; keyboard?: string } | null {
  try {
    const content = fs.readFileSync('/proc/bus/input/devices', 'utf8');
    const blocks = content.split('\n\n');
    
    let joystickEventNum: string | undefined;
    let keyboardEventNum: string | undefined;
    
    for (const block of blocks) {
      const lower = block.toLowerCase();
      
      // Look for 8BitDo devices
      if (lower.includes('8bitdo') || lower.includes('8BitDo')) {
        // Extract the handlers line
        const handlerMatch = block.match(/Handlers=([^\n]+)/i);
        if (!handlerMatch) continue;
        
        const handlers = handlerMatch[1];
        
        // Extract event number from handlers like "kbd event16" or "js0 event17"
        const eventMatch = handlers.match(/event(\d+)/);
        if (!eventMatch) continue;
        
        const eventNum = eventMatch[1];
        
        // Determine if this is joystick or keyboard interface
        if (handlers.includes('js') && handlers.includes('event')) {
          joystickEventNum = eventNum;
        } else if (handlers.includes('kbd') && handlers.includes('event')) {
          keyboardEventNum = eventNum;
        }
      }
    }
    
    return {
      joystick: joystickEventNum ? `/dev/input/event${joystickEventNum}` : undefined,
      keyboard: keyboardEventNum ? `/dev/input/event${keyboardEventNum}` : undefined,
    };
  } catch (error) {
    return null;
  }
}

function listById(): string[] {
  try {
    return fs.readdirSync(BY_ID_DIR).map(f => path.join(BY_ID_DIR, f));
  } catch {
    return [];
  }
}

// Returns the /dev/input/by-id symlink for the keyboard interface if found.
// Do NOT resolve it here; callers can resolve separately when needed.
function findKeyboardById(joystickByIdPath: string): string | undefined {
  try {
    const base = path.basename(joystickByIdPath);
    const stem = base.replace(/-event-joystick$/, '');
    
    const entries = fs.readdirSync(BY_ID_DIR);
    
    // Look for keyboard interface with same stem
    const patterns = [
      `${stem}-if01-event-kbd`,
      `${stem}-if02-event-kbd`,
      `${stem}-event-kbd`,
    ];
    
    for (const pattern of patterns) {
      if (entries.includes(pattern)) {
        const full = path.join(BY_ID_DIR, pattern);
        // Return symlink path; resolution happens later for real path
        return full;
      }
    }
  } catch {
    // Ignore errors, fallback to other methods
  }
  return undefined;
}

function resolveCandidate(matchSubstr?: string): Detected {
  // First try by-id method
  const entries = listById().filter(p => p.endsWith('event-joystick'));
  let filtered = entries;
  if (matchSubstr) {
    const m = matchSubstr.toLowerCase();
    filtered = entries.filter(p => path.basename(p).toLowerCase().includes(m));
  }

  const best = filtered[0] || entries[0];
  
  if (best) {
    // Resolve joystick path
    let realPath = '';
    try {
      const link = fs.readlinkSync(best);
      realPath = path.resolve(path.dirname(best), link);
    } catch {}

    // Try to find keyboard interface
    const keyboardByIdPath = findKeyboardById(best);
    let keyboardRealPath = '';
    if (keyboardByIdPath) {
      try {
        if (fs.lstatSync(keyboardByIdPath).isSymbolicLink()) {
          const link = fs.readlinkSync(keyboardByIdPath);
          keyboardRealPath = path.resolve(path.dirname(keyboardByIdPath), link);
        } else {
          // If by-id returns a non-symlink path (unlikely), treat it as real path
          keyboardRealPath = keyboardByIdPath;
        }
      } catch {}
    }

    return {
      status: 'READY',
      when: now(),
      byId: best,
      eventPath: best,
      realEventPath: realPath || undefined,
      keyboardById: keyboardByIdPath,
      keyboardEventPath: keyboardByIdPath, // keep for backward compat; may be by-id symlink
      realKeyboardEventPath: keyboardRealPath || undefined,
      mode: guessMode(path.basename(best)),
    };
  }

  // Fallback to /proc/bus/input/devices parsing
  const procDevices = parseInputDevices();
  if (procDevices && (procDevices.joystick || procDevices.keyboard)) {
    return {
      status: 'READY',
      when: now(),
      eventPath: procDevices.joystick,
      realEventPath: procDevices.joystick,
      keyboardEventPath: procDevices.keyboard,
      realKeyboardEventPath: procDevices.keyboard,
      mode: 'dinput', // Assume 8BitDo is DInput mode
    };
  }

  return { status: 'WAITING', when: now() };
}

function printStatus(det: Detected) {
  if (det.status === 'WAITING') {
    console.log(`WAITING ${JSON.stringify({ when: det.when })}`);
  } else {
    const result = {
      when: det.when,
      byId: det.byId,
      eventPath: det.eventPath,
      realEventPath: det.realEventPath,
      keyboardById: det.keyboardById,
      keyboardEventPath: det.keyboardEventPath,
      realKeyboardEventPath: det.realKeyboardEventPath,
      mode: det.mode,
    };
    console.log(`READY ${JSON.stringify(result)}`);
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
