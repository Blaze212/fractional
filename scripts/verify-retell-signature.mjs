#!/usr/bin/env node
// Standalone, independent check of a Retell webhook signature — deliberately
// outside apps/adjuster, using Node's built-in crypto (the same HMAC-SHA256
// primitive Retell's own SDK uses under the hood via Web Crypto) so a bug in
// webhook.js's hand-rolled Apps Script version can't hide behind itself.
//
// Usage:
//   RETELL_API_KEY=<the real key, never pasted to anyone> \
//     node scripts/verify-retell-signature.mjs path/to/mismatch-row.json
//
// Where mismatch-row.json is the full JSON blob from one `retell.signature_
// mismatch` row in the Jobs sheet's Raw tab, pasted in as-is (it already
// carries raw_body, timestamp, expected_digest, received_digest verbatim —
// nothing here re-parses or re-serializes the raw body itself).
//
// If retell-sdk is installed (`npm install retell-sdk`), this also runs
// their actual `verify()`/`sign()` functions for a second, fully independent
// confirmation — not just this script's own crypto.createHmac call.

import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'

const path = process.argv[2]
if (!path) {
  console.error(
    'Usage: RETELL_API_KEY=... node scripts/verify-retell-signature.mjs <mismatch-row.json>',
  )
  process.exit(1)
}

const apiKey = process.env.RETELL_API_KEY
if (!apiKey) {
  console.error(
    'Set RETELL_API_KEY in the environment — never pass it as an argument (shell history).',
  )
  process.exit(1)
}

const row = JSON.parse(readFileSync(path, 'utf-8'))
const {
  raw_body: rawBody,
  timestamp,
  expected_digest: expectedFromProd,
  received_digest: receivedFromRetell,
} = row

if (typeof rawBody !== 'string' || !timestamp) {
  console.error('Expected fields raw_body and timestamp in the pasted row — got:', Object.keys(row))
  process.exit(1)
}

function localDigest() {
  return createHmac('sha256', apiKey)
    .update(rawBody + timestamp)
    .digest('hex')
}

console.log('raw_body length:', rawBody.length)
console.log('timestamp:', timestamp)
console.log()

const local = localDigest()
console.log('locally computed digest:       ', local)
console.log('production expected_digest:    ', expectedFromProd)
console.log('  -> match:', local === expectedFromProd)
console.log('Retell-sent received_digest:   ', receivedFromRetell)
console.log('  -> match:', local === receivedFromRetell)

// If retell-sdk is installed, cross-check with their actual code too —
// not just the same algorithm re-typed a third time.
try {
  const { verify, sign } = await import('retell-sdk')
  const fakeSig = 'v=' + timestamp + ',d=' + receivedFromRetell
  const sdkResult = await verify(rawBody, apiKey, fakeSig)
  console.log()
  console.log('retell-sdk verify() against received_digest:', sdkResult)
  const resigned = await sign(rawBody, apiKey, Number(timestamp))
  console.log('retell-sdk sign() output:                    ', resigned)
} catch (err) {
  if (err.code === 'ERR_MODULE_NOT_FOUND') {
    console.log()
    console.log(
      '(retell-sdk not installed — run `npm install retell-sdk` for a second, independent check)',
    )
  } else {
    throw err
  }
}

console.log()
if (local === receivedFromRetell) {
  console.log('=> Algorithm + key are correct. Whatever produced expected_digest in production')
  console.log('   was NOT using this raw_body/timestamp/key combination — look at the Apps Script')
  console.log('   runtime (Utilities.computeHmacSha256Signature) or something changing between')
  console.log('   the row captured here and what actually ran.')
} else if (local === expectedFromProd) {
  console.log('=> This confirms production computed the digest correctly from this exact raw_body')
  console.log('   and key. The received_digest genuinely does not match — the raw bytes Retell')
  console.log('   hashed on their end must differ from what reached Apps Script. Time to compare')
  console.log(
    "   this raw_body against Retell's own webhook delivery log, if their dashboard has one.",
  )
} else {
  console.log('=> Neither matches. Something in this specific raw_body/timestamp/key does not')
  console.log('   reproduce ANY of the digests we already have — re-check the key value and that')
  console.log('   this row was pasted in without any edits.')
}
