import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

export interface TemplateConfig {
  icon_path: string;
  contrast_path: string;
  scales: number[];
  ncc_threshold: number;
}

export interface LoadedTemplate {
  setCode: string;
  config: TemplateConfig;
  icon: Buffer;
  contrast: Buffer;
  width: number;
  height: number;
  contrastWidth: number;
  contrastHeight: number;
}

export type TemplateMap = Map<string, LoadedTemplate>;

/**
 * Loads set icon templates (normal + high‑contrast) defined in a manifest file.
 * The manifest is produced by compile-set-catalog.ts via --emit-manifest.
 */
export async function preloadSetIconTemplates(manifestPath = path.join('data', 'set_icons', 'manifest.json')): Promise<TemplateMap> {
  const absManifest = path.resolve(process.cwd(), manifestPath);
  if (!fs.existsSync(absManifest)) {
    throw new Error(`Manifest not found: ${absManifest}`);
  }
  const manifest = JSON.parse(fs.readFileSync(absManifest, 'utf8')) as Record<string, TemplateConfig>;
  const entries = Object.entries(manifest);
  const templates: TemplateMap = new Map();

  const concurrency = 8;
  let index = 0;

  async function loadOne(setCode: string, cfg: TemplateConfig): Promise<void> {
    const iconAbs = path.resolve(process.cwd(), cfg.icon_path);
    const contrastAbs = path.resolve(process.cwd(), cfg.contrast_path);
    if (!fs.existsSync(iconAbs)) {
      console.warn(`preload: icon missing for ${setCode}: ${iconAbs}`);
      return;
    }
    if (!fs.existsSync(contrastAbs)) {
      console.warn(`preload: contrast icon missing for ${setCode}: ${contrastAbs}`);
      return;
    }
    const [iconBuf, contrastBuf] = await Promise.all([
      fs.promises.readFile(iconAbs),
      fs.promises.readFile(contrastAbs)
    ]);
    const [meta, cmeta] = await Promise.all([
      sharp(iconBuf).metadata(),
      sharp(contrastBuf).metadata()
    ]);
    templates.set(setCode, {
      setCode,
      config: cfg,
      icon: iconBuf,
      contrast: contrastBuf,
      width: meta.width || 0,
      height: meta.height || 0,
      contrastWidth: cmeta.width || 0,
      contrastHeight: cmeta.height || 0,
    });
  }

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= entries.length) return;
      const [setCode, cfg] = entries[i];
      try {
        await loadOne(setCode, cfg);
      } catch (err: any) {
        console.warn(`preload: failed for ${setCode}: ${err?.message || String(err)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return templates;
}

export function getTemplate(map: TemplateMap, setCode: string): LoadedTemplate | undefined {
  return map.get(setCode);
}

/**
 * Utility to summarize what was loaded. Useful for logging at startup.
 */
export function summarizeTemplates(map: TemplateMap) {
  const total = map.size;
  let missing = 0;
  for (const [, t] of map) {
    if (!t.width || !t.height || !t.contrastWidth || !t.contrastHeight) missing++;
  }
  return { total, missing };
}

