// (Codex-CTO) HEIC normalizer interface — sharp fast-path + CLI fallback
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import sharp from 'sharp';
import { createLogger } from '../utils/logger';

const logger = createLogger('heic-normalizer');

export interface HeicNormalizeOptions {
  quality?: number; // JPEG quality 1-100 (default 90)
  maxDimPx?: number; // Optional max width/height (resize keeping aspect)
  preserveMetadata?: boolean; // Copy EXIF/ICC if available (default true)
  tmpDir?: string; // Where to write CLI fallback outputs (default os.tmpdir())
}

export interface HeicNormalizeResult {
  jpegBuffer: Buffer;
  info: {
    width?: number;
    height?: number;
    sizeBytes: number;
    originalSizeBytes?: number;
    method: 'sharp' | 'heif-convert';
    warnings?: string[];
  };
}

export function heicSupportAvailable(): boolean {
  try {
    // sharp exposes format support flags — require libvips built with libheif
    // @ts-ignore - format is present at runtime
    const supported = !!sharp.format?.heif?.input;
    return supported;
  } catch {
    return false;
  }
}

export function isHeicFilename(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.heic' || ext === '.heif';
}

async function readSourceToBuffer(source: Buffer | string): Promise<Buffer> {
  if (Buffer.isBuffer(source)) return source;
  return fs.readFile(source);
}

/**
 * Normalize a HEIC/HEIF image to baseline JPEG for downstream compatibility.
 * Tries sharp (libheif) first; falls back to `heif-convert` if available.
 */
export async function normalizeHeic(
  source: Buffer | string,
  opts: HeicNormalizeOptions = {}
): Promise<HeicNormalizeResult> {
  const quality = clampQuality(opts.quality ?? envQuality());
  const maxDim = opts.maxDimPx ?? envMaxDim();
  const preserve = opts.preserveMetadata ?? true;

  const inputBuffer = await readSourceToBuffer(source);
  const originalSize = inputBuffer.byteLength;

  const warnings: string[] = [];

  if (heicSupportAvailable()) {
    try {
      let pipeline = sharp(inputBuffer, { sequentialRead: true });

      if (maxDim && maxDim > 0) {
        pipeline = pipeline.resize({
          width: maxDim,
          height: maxDim,
          fit: 'inside',
          withoutEnlargement: true,
          fastShrinkOnLoad: true,
        });
      }

      if (preserve) {
        pipeline = pipeline.withMetadata();
      }

      const { data, info } = await pipeline.jpeg({ quality, mozjpeg: false }).toBuffer({ resolveWithObject: true });

      return {
        jpegBuffer: data,
        info: {
          width: info.width,
          height: info.height,
          sizeBytes: data.byteLength,
          originalSizeBytes: originalSize,
          method: 'sharp',
          warnings,
        },
      };
    } catch (err: any) {
      warnings.push(`sharp-convert-failed: ${err?.message || String(err)}`);
      logger.warn('HEIC normalize via sharp failed — will try CLI fallback', { err });
      // fall through to CLI
    }
  } else {
    warnings.push('sharp-heif-unsupported');
  }

  // CLI fallback via heif-convert
  return await heifConvertFallback(source, { quality, maxDimPx: maxDim, tmpDir: opts.tmpDir, warnings });
}

async function heifConvertFallback(
  source: Buffer | string,
  opts: HeicNormalizeOptions & { warnings?: string[] }
): Promise<HeicNormalizeResult> {
  const quality = clampQuality(opts.quality ?? envQuality());
  const tmpDir = opts.tmpDir || os.tmpdir();
  const warnings = opts.warnings || [];

  // Write input to a temp .heic if buffer
  const inputTmp = Buffer.isBuffer(source)
    ? path.join(tmpDir, `cardmint-heic-${Date.now()}-${Math.random().toString(16).slice(2)}.heic`)
    : (source as string);
  const cleanupInput = Buffer.isBuffer(source);

  if (cleanupInput) {
    await fs.writeFile(inputTmp, source as Buffer);
  }

  const outputTmp = path.join(tmpDir, `cardmint-heic-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`);

  // heif-convert [-q quality] input.heic output.jpg
  await execFileStrict('heif-convert', ['-q', String(quality), inputTmp, outputTmp]);

  const jpegBuffer = await fs.readFile(outputTmp);
  const size = jpegBuffer.byteLength;

  // Best-effort cleanup
  Promise.allSettled([
    cleanupInput ? fs.unlink(inputTmp) : Promise.resolve(),
    fs.unlink(outputTmp),
  ]).catch(() => {});

  return {
    jpegBuffer,
    info: {
      sizeBytes: size,
      originalSizeBytes: Buffer.isBuffer(source) ? (source as Buffer).byteLength : undefined,
      method: 'heif-convert',
      warnings,
    },
  };
}

function envQuality(): number {
  const v = Number(process.env.HEIC_NORMALIZE_QUALITY || '90');
  return clampQuality(isFinite(v) ? v : 90);
}

function envMaxDim(): number | undefined {
  const v = process.env.HEIC_MAX_DIM_PX ? Number(process.env.HEIC_MAX_DIM_PX) : undefined;
  return v && isFinite(v) && v > 0 ? v : undefined;
}

function clampQuality(q: number): number {
  return Math.max(1, Math.min(100, Math.round(q)));
}

async function execFileStrict(cmd: string, args: string[]): Promise<void> {
  logger.debug(`exec: ${cmd} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`Command failed (${code}): ${cmd} ${args.join(' ')}${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

// Convenience wrapper: normalize only if input path ends with .heic/.heif
export async function normalizeIfHeic(
  sourcePath: string,
  opts: HeicNormalizeOptions = {}
): Promise<{ normalizedPath: string | null; result?: HeicNormalizeResult }> {
  if (!isHeicFilename(sourcePath)) {
    return { normalizedPath: null };
  }
  const res = await normalizeHeic(sourcePath, opts);
  const targetPath = sourcePath.replace(/\.(heic|heif)$/i, '.jpg');
  await fs.writeFile(targetPath, res.jpegBuffer);
  return { normalizedPath: targetPath, result: res };
}

