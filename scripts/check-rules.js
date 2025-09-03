#!/usr/bin/env node
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

const RULES_DIR = new URL('../rules/', import.meta.url)
const SERVICE_DIR = new URL('../service/', import.meta.url)
const BASE_URL = process.env.MANGLE_BASE_URL || 'http://localhost:8089'

async function computeRulesHash() {
  const entries = await fs.readdir(RULES_DIR)
  const mg = entries.filter((n) => n.endsWith('.mg')).sort()
  const h = crypto.createHash('sha256')
  for (const name of mg) {
    h.update(name)
    h.update(await fs.readFile(new URL(`../rules/${name}`, import.meta.url)))
  }
  return h.digest('hex')
}

async function httpPost(path, body) {
  const res = await fetch(BASE_URL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`)
  }
  return res.json().catch(() => ({}))
}

async function ensureService() {
  try {
    await fetch(BASE_URL + '/healthz')
    return { proc: null }
  } catch {}
  // Spawn service
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CARDMINT_RULES_BRAIN_ENABLED: '1' }
    const child = spawn('go', ['run', './service'], { cwd: new URL('../', import.meta.url), env, stdio: 'inherit', shell: false })
    let tries = 0
    const i = setInterval(async () => {
      tries++
      try {
        const r = await fetch(BASE_URL + '/healthz')
        if (r.ok) { clearInterval(i); resolve({ proc: child }) }
      } catch {}
      if (tries > 50) { clearInterval(i); child.kill(); reject(new Error('service did not start')) }
    }, 200)
  })
}

function printHelp() {
  console.log(`Usage: node scripts/check-rules.js [--base-url URL] [--rules DIR]\n\n` +
    `Checks .mg rules: parses/stratifies via service and rejects obvious negation.\n` +
    `Options:\n` +
    `  --base-url URL   Service base URL (default ${BASE_URL})\n` +
    `  --rules DIR      Rules directory (default ../rules)\n`)
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp(); return
  }
  const buIdx = process.argv.indexOf('--base-url')
  if (buIdx > -1 && process.argv[buIdx+1]) {
    // overwrite BASE_URL locally
    globalThis.BASE_URL = process.argv[buIdx+1]
  }
  const rdIdx = process.argv.indexOf('--rules')
  if (rdIdx > -1 && process.argv[rdIdx+1]) {
    // not strictly needed since we shell to service, but use for local text scans
  }
  const { proc } = await ensureService()
  const hash = await computeRulesHash()
  // An empty facts load forces rules parse+analyze+stratify on the server.
  await httpPost('/facts:load', { ruleset_hash: hash, facts: [] })
  // Basic guardrails: forbid obvious negation tokens in rules text.
  const files = await fs.readdir(RULES_DIR)
  for (const f of files) {
    if (!f.endsWith('.mg')) continue
    const text = await fs.readFile(new URL(`../rules/${f}`, import.meta.url), 'utf8')
    if (/\bnot\b|!\w+\(/.test(text)) {
      throw new Error(`negation detected in ${f}`)
    }
  }
  if (proc) proc.kill()
  console.log('#PASS rules ok')
}

main().catch((e) => { console.error(e.message || e); process.exit(1) })
