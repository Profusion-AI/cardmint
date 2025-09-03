#!/usr/bin/env node
import { MangleClient } from '../mangle-adapter.js'
import fs from 'node:fs/promises'

function printHelp() {
  console.log(`Usage: node adapter/examples/run.js [--predicate NAME] [--limit N] [--no-explain]\n\n` +
    `Loads sample facts and runs queries against the sidecar.\n` +
    `Options:\n` +
    `  --predicate NAME  One of: valid_card|duplicate_of|price_for (default: all)\n` +
    `  --limit N         Limit rows (default: 50)\n` +
    `  --no-explain      Do not request derivations\n`)
}

if (process.argv.includes('--help') || process.argv.includes('-h')) { printHelp(); process.exit(0) }

const predIdx = process.argv.indexOf('--predicate')
const onePred = predIdx > -1 ? process.argv[predIdx+1] : null
const limIdx = process.argv.indexOf('--limit')
const limit = limIdx > -1 ? Number(process.argv[limIdx+1]) : 50
const explain = !process.argv.includes('--no-explain')

const client = new MangleClient()
const path = new URL('../../facts/sample.json', import.meta.url)
const batch = JSON.parse(await fs.readFile(path, 'utf8'))
await client.loadFacts(batch)

const run = async (predicate) => {
  const res = await client.query({ predicate, explain, limit })
  console.log(`${predicate} =>`, JSON.stringify(res, null, 2))
}

if (onePred) {
  await run(onePred)
} else {
  await run('valid_card')
  await run('duplicate_of')
  await run('price_for')
}
