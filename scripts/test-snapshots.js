#!/usr/bin/env node
import fs from 'node:fs/promises'
import assert from 'node:assert'

const BASE_URL = process.env.MANGLE_BASE_URL || 'http://localhost:8089'

async function httpPost(path, body) {
  const res = await fetch(BASE_URL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`)
  }
  return res.json().catch(() => ({}))
}

function cell(v) {
  // strip quotes if present
  if (typeof v !== 'string') return String(v)
  return v.replace(/^"|"$/g, '')
}

async function main() {
  const sample = JSON.parse(await fs.readFile(new URL('../facts/sample.json', import.meta.url), 'utf8'))
  await httpPost('/facts:load', sample)
  // valid_card
  const v1 = await httpPost('/query', { predicate: 'valid_card', explain: true })
  assert.ok(Array.isArray(v1.rows) && v1.rows.some((r) => cell(r[0]) === 'c1'), 'valid_card(c1) missing')
  assert.ok((v1.derivation||[]).length >= 1, 'valid_card derivation empty')
  // duplicate_of
  const v2 = await httpPost('/query', { predicate: 'duplicate_of', explain: true })
  const hasDup = v2.rows.some((r) => cell(r[0]) === 'c1' && cell(r[1]) === 'c2')
  assert.ok(hasDup, 'duplicate_of(c1,c2) missing')
  // price_for
  const v3 = await httpPost('/query', { predicate: 'price_for', explain: true })
  const ok = v3.rows.some((r) => cell(r[0]) === 'c1' && cell(r[1]) === 'weighted')
  assert.ok(ok, 'price_for(c1,"weighted",P) missing')
  // negative tests
  await fetch(BASE_URL + '/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ predicate: 'unknown_pred', args: [] }) })
    .then(async (res) => { assert.ok(res.status === 400, 'unknown predicate should 400') })
  await fetch(BASE_URL + '/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ predicate: 'valid_card', args: ['a','b'] }) })
    .then(async (res) => { assert.ok(res.status === 422, 'wrong arity should 422') })
  console.log('#PASS snapshots ok')
}

main().catch((e) => { console.error(e.message||e); process.exit(1) })
