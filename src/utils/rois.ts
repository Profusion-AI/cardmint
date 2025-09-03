import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

export type RoiPack = {
  deskew: string;
  name: string;
  number: string;
  symbol: string;
};

export async function generateRois(inputPath: string): Promise<RoiPack> {
  const prefix = inputPath.replace(/(\.[^.]+)$/i, '');
  const outPrefix = prefix; // write alongside input
  await execPython(path.join(process.cwd(), 'scripts', 'opencv_rois.py'), [inputPath, outPrefix]);
  const pack: RoiPack = {
    deskew: `${outPrefix}.deskew.jpg`,
    name: `${outPrefix}.name.jpg`,
    number: `${outPrefix}.number.jpg`,
    symbol: `${outPrefix}.symbol.jpg`,
  };
  // Best-effort existence check
  for (const p of Object.values(pack)) {
    try { await access(p); } catch { /* ignore - worker can skip missing */ }
  }
  return pack;
}

export function roiPackFromBasePath(inputPath: string): RoiPack {
  const prefix = inputPath.replace(/(\.[^.]+)$/i, '');
  return {
    deskew: `${prefix}.deskew.jpg`,
    name: `${prefix}.name.jpg`,
    number: `${prefix}.number.jpg`,
    symbol: `${prefix}.symbol.jpg`,
  };
}

function execPython(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', [scriptPath, ...args], { stdio: 'inherit' });
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`python ${scriptPath} exited with ${code}`));
    });
    p.on('error', (err) => reject(err));
  });
}

