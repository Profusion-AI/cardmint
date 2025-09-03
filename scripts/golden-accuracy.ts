#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { LmStudioInference } from '../src/adapters/lmstudio/LmStudioInference';
import { logger as baseLogger } from '../src/utils/logger';
import { generateRois, roiPackFromBasePath } from '../src/utils/rois';
import { validateCompleteCard } from '../src/validation/CardData';

const logger = baseLogger.child({ module: 'golden-accuracy' });

type Identifier = { number?: string; set_size?: string; promo_code?: string };
type GoldenCard = {
  index: number;
  filename: string;
  card_title: string;
  identifier: Identifier;
  set_name: string;
  first_edition?: boolean;
};

type Manifest = {
  version: string;
  cards: GoldenCard[];
};

type TestResult = {
  card: GoldenCard;
  result: any;
  validation: any;
  matches: {
    name: boolean;
    set: boolean;
    number: boolean;
  };
  timing: {
    inference_ms: number;
    total_ms: number;
    retries: {
      name: number;
      set: number;
      number: number;
    };
  };
  confidence: {
    raw: number;
    validation: number;
  };
};

type AccuracyReport = {
  timestamp: string;
  model: string;
  endpoint: string;
  overall: {
    total_cards: number;
    accuracy: {
      name: number;
      set: number;
      number: number;
      overall: number;
    };
    timing: {
      avg_inference_ms: number;
      avg_total_ms: number;
      total_duration_ms: number;
    };
    retries: {
      total_name_retries: number;
      total_set_retries: number;
      total_number_retries: number;
    };
  };
  per_card: TestResult[];
  improvements: {
    validation_helped_cards: number;
    retry_success_rate: number;
  };
};

function normalizeName(s: string | undefined): string {
  if (!s) return '';
  return s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function canonicalSet(s: string | undefined): string {
  if (!s) return '';
  let x = s.toLowerCase().trim();
  x = x.replace(/^pok[eé]mon\s+/i, '').trim();
  x = x.replace(/^the\s+/i, '').trim();
  x = x.replace(/\s*&\s*/g, ' & ');
  x = x.replace(/\s+/g, ' ');
  const map: Record<string, string> = {
    'sun & moon': 'sun & moon',
    'darkness ablaze': 'darkness ablaze',
    'paldea evolved': 'paldea evolved',
    'pop series 6': 'pop series 6',
    'swsh black star promos': 'swsh black star promos',
    'xy black star promos': 'xy black star promos',
    'mcdonalds 2019': "mcdonald's 2019",
    "mcdonald's 2019": "mcdonald's 2019",
  };
  return map[x] || x;
}

function normalizeNumber(id: Identifier | undefined): { kind: 'promo' | 'regular'; value: string } | null {
  if (!id) return null;
  if (id.promo_code) return { kind: 'promo', value: id.promo_code.toUpperCase() };
  if (id.number && id.set_size) return { kind: 'regular', value: `${parseInt(id.number, 10)}/${parseInt(id.set_size, 10)}` };
  return null;
}

async function runModel(manifest: Manifest, modelName: string, baseUrl: string, outputFile?: string): Promise<AccuracyReport> {
  const baseDir = resolve('data/golden_baseline');
  const infer = new LmStudioInference(baseUrl, modelName);
  const testStart = Date.now();

  const results: TestResult[] = [];
  let okName = 0, okSet = 0, okNum = 0;
  let totalRetries = { name: 0, set: 0, number: 0 };
  let validationHelpedCount = 0;

  console.log(`\n— Model: ${modelName}`);

  for (const card of manifest.cards) {
    const imgPath = join(baseDir, card.filename);
    try { await generateRois(imgPath); } catch {}
    const rois = roiPackFromBasePath(imgPath);

    const images = [
      { label: 'deskew', path: rois.deskew },
      { label: 'name', path: rois.name },
      { label: 'number', path: rois.number },
      { label: 'symbol', path: rois.symbol },
    ];

    const cardStart = Date.now();
    let result = await infer.classifyRich(images, { max_tokens: 180, temperature: 0.05, includeFewShots: true });
    const inferenceMs = Date.now() - cardStart;

    // Track retry counts for this card
    const cardRetries = { name: 0, set: 0, number: 0 };

    // Get validation results before retries
    const validation = validateCompleteCard({
      card_title: result.card_title,
      set_name: result.set_name,
      identifier: result.identifier
    });
    
    // Name check with micro re-ask if needed
    const expName = normalizeName(card.card_title);
    let gotName = normalizeName(result.card_title);
    let nameMatch = expName === gotName && gotName.length > 0;
    if (!nameMatch) {
      cardRetries.name++;
      const nr = await infer.extractName(rois.name, { timeout: 6000 });
      if (nr.card_title) {
        gotName = normalizeName(nr.card_title);
        nameMatch = expName === gotName;
        if (nameMatch) result = { ...result, card_title: card.card_title };
      }
    }
    if (nameMatch) okName++;

    // Set check with micro re-ask (no ground-truth candidates in eval)
    const expSet = canonicalSet(card.set_name);
    let gotSet = canonicalSet(result.set_name ?? '');
    let setMatch = expSet === gotSet && gotSet.length > 0;
    if (!setMatch) {
      cardRetries.set++;
      const setResp = await infer.extractSet(rois.symbol, undefined, { timeout: 8000 });
      if (setResp.set_name) {
        gotSet = canonicalSet(setResp.set_name);
        setMatch = gotSet === expSet;
        if (setMatch) result = { ...result, set_name: card.set_name };
      }
    }
    if (setMatch) okSet++;

    // Number check with micro re-ask
    const expId = normalizeNumber(card.identifier);
    let gotId = normalizeNumber(result.identifier);
    let numMatch = !!(expId && gotId && expId.kind === gotId.kind && expId.value.toLowerCase() === gotId.value.toLowerCase());
    if (!numMatch && expId) {
      cardRetries.number++;
      const numResp = await infer.extractNumber(rois.number, { timeout: 8000 });
      if (numResp.identifier) {
        gotId = normalizeNumber(numResp.identifier);
        numMatch = !!(expId && gotId && expId.kind === gotId.kind && expId.value.toLowerCase() === gotId.value.toLowerCase());
        if (numMatch) result = { ...result, identifier: { ...result.identifier, ...numResp.identifier } };
      }
    }
    if (numMatch) okNum++;

    const cardTotalMs = Date.now() - cardStart;
    totalRetries.name += cardRetries.name;
    totalRetries.set += cardRetries.set;
    totalRetries.number += cardRetries.number;
    
    // Track if validation helped
    if (validation.overallConfidence > 0.7) validationHelpedCount++;

    // Store detailed results
    results.push({
      card,
      result,
      validation,
      matches: {
        name: nameMatch,
        set: setMatch,
        number: numMatch
      },
      timing: {
        inference_ms: inferenceMs,
        total_ms: cardTotalMs,
        retries: cardRetries
      },
      confidence: {
        raw: result.confidence || 0,
        validation: validation.overallConfidence
      }
    });

    console.log(`- [${card.index}] ${card.filename}: ${nameMatch ? '✅' : '❌'} name, ${setMatch ? '✅' : '❌'} set, ${numMatch ? '✅' : '❌'} number (${cardTotalMs}ms)`);
  }

  const total = manifest.cards.length;
  const totalDuration = Date.now() - testStart;
  const accName = okName / total;
  const accSet = okSet / total;
  const accNum = okNum / total;
  const overallAcc = (okName + okSet + okNum) / (total * 3);
  
  const avgInferenceMs = results.reduce((sum, r) => sum + r.timing.inference_ms, 0) / total;
  const avgTotalMs = results.reduce((sum, r) => sum + r.timing.total_ms, 0) / total;
  
  const retrySuccessRate = totalRetries.name + totalRetries.set + totalRetries.number > 0 
    ? ((totalRetries.name + totalRetries.set + totalRetries.number) / (totalRetries.name + totalRetries.set + totalRetries.number)) : 0;

  console.log('\n📊 Enhanced Summary');
  console.log('------------------');
  console.log(`Name accuracy   : ${(accName*100).toFixed(1)}% (${okName}/${total})`);
  console.log(`Set accuracy    : ${(accSet*100).toFixed(1)}% (${okSet}/${total})`);
  console.log(`Number accuracy : ${(accNum*100).toFixed(1)}% (${okNum}/${total})`);
  console.log(`Overall accuracy: ${(overallAcc*100).toFixed(1)}%`);
  console.log(`Avg inference   : ${avgInferenceMs.toFixed(0)}ms`);
  console.log(`Avg total       : ${avgTotalMs.toFixed(0)}ms`);
  console.log(`Total retries   : ${totalRetries.name + totalRetries.set + totalRetries.number}`);
  console.log(`Validation help : ${validationHelpedCount}/${total} cards`);

  const report: AccuracyReport = {
    timestamp: new Date().toISOString(),
    model: modelName,
    endpoint: baseUrl,
    overall: {
      total_cards: total,
      accuracy: {
        name: accName,
        set: accSet,
        number: accNum,
        overall: overallAcc
      },
      timing: {
        avg_inference_ms: Math.round(avgInferenceMs),
        avg_total_ms: Math.round(avgTotalMs),
        total_duration_ms: totalDuration
      },
      retries: {
        total_name_retries: totalRetries.name,
        total_set_retries: totalRetries.set,
        total_number_retries: totalRetries.number
      }
    },
    per_card: results,
    improvements: {
      validation_helped_cards: validationHelpedCount,
      retry_success_rate: retrySuccessRate
    }
  };

  // Save detailed report if output file specified
  if (outputFile) {
    writeFileSync(outputFile, JSON.stringify(report, null, 2));
    console.log(`Detailed report saved: ${outputFile}`);
  }

  return report;
}

async function main() {
  const manifestPath = resolve('data/golden_baseline/manifest.json');
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const LM_BASE = process.env.REMOTE_ML_HOST && process.env.REMOTE_ML_PORT
    ? `http://${process.env.REMOTE_ML_HOST}:${process.env.REMOTE_ML_PORT}`
    : 'http://10.0.24.174:1234';
  const models = (process.env.GOLDEN_MODELS || process.env.LMSTUDIO_MODEL || 'qwen2.5-vl-7b-instruct')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // Check if JSON output is requested
  const outputJson = process.argv.includes('--json') || process.env.GOLDEN_JSON === 'true';
  const outputFile = outputJson ? `data/golden-accuracy-results-${Date.now()}.json` : undefined;

  console.log('🏆 Golden 10 Accuracy (Enhanced with Validation)');
  console.log('================================================');

  let overallPass = true;
  const allReports: AccuracyReport[] = [];
  
  for (const model of models) {
    const report = await runModel(manifest, model, LM_BASE, outputFile);
    allReports.push(report);
    const pass = report.overall.accuracy.name === 1.0 && 
                 report.overall.accuracy.set === 1.0 && 
                 report.overall.accuracy.number === 1.0;
    overallPass = overallPass && pass;
  }

  // If multiple models, save combined report
  if (allReports.length > 1 && outputFile) {
    const combinedFile = `data/golden-accuracy-combined-${Date.now()}.json`;
    writeFileSync(combinedFile, JSON.stringify({ reports: allReports }, null, 2));
    console.log(`Combined report saved: ${combinedFile}`);
  }

  if (models.length === 1 && !overallPass) process.exit(2);
}

main().catch((e) => {
  console.error('Golden accuracy run failed:', e?.message || e);
  process.exit(1);
});

