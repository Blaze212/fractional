# Adjuster regression corpus

One directory per call under `calls/`. Each holds everything the portable core
needs to produce a draft, plus the validated field map those inputs are expected
to produce.

Two things run these fixtures, over the same core, so a difference between them
is always a model changing its mind and never the two harnesses disagreeing
about how to set the call up:

| Runner                               | When                                             | Vendor calls |
| ------------------------------------ | ------------------------------------------------ | ------------ |
| `tests/unit/adjuster/corpus.test.ts` | every `pnpm test`                                | none         |
| `scripts/adjuster-corpus-live.mjs`   | manual dispatch or weekly, via a separate CI job | real         |

The default suite replays `responses.json` through a stub `deps.fetch`. It is
deterministic, free, and it preserves the invariant `sandbox.test.ts` asserts:
`pnpm test` cannot dial a vendor. An unrecorded response throws rather than
falling through to the network.

The live job runs the same fixtures against real models and prints a
field-by-field diff. That is what makes a prompt or model change show its blast
radius before it merges — run it from the Actions tab
(`.github/workflows/adjuster-corpus-live.yml`) on any PR that touches
`core/prompt.js`, the tag schema, or a model id.

## Layout

```
calls/<name>/
  call.json                  the call: ids, claim, candidates, live export
  sources/*.txt              one file per ASR source
  tagSchema.json             per-client field definitions (today's enums.json)
  glossary.json              per-client trade vocabulary
  responses.json             recorded LLM responses, keyed by JSON-schema name
  expected-validated.json    what core.run's `validated` must come out as
```

`call.json` uses the same shape `scripts/adjuster-core-run.mjs` reads, so a
fixture doubles as a call spec for the Node harness:

```json
{
  "captureId": "fixture-hail-roof",
  "callStartedAt": "2026-06-20T14:31:00Z",
  "sources": { "elevenlabs": "sources/elevenlabs.txt", "dograh": "sources/dograh.txt" },
  "precedence": ["elevenlabs", "qwen", "dograh"],
  "claim": { "claim_id": "FIXTURE-0001", "insured_last_name": "Okonkwo" },
  "claims": [],
  "liveFields": { "mortgage_status": "has_mortgage" },
  "tagSchema": "tagSchema.json",
  "glossary": "glossary.json"
}
```

`responses.json` is keyed by the `response_format.json_schema.name` core sends —
`master_transcript` for the merge, `extraction` for the field pass — and each
value is a whole OpenRouter chat-completions body. A fixture with a single
source has no `master_transcript` entry, because core skips the merge rather
than asking a model to restate one transcript.

## Adding a fixture

1. Make the directory and write `call.json`, the source transcripts, the tag
   schema, and the glossary.
2. Capture the LLM responses. Either run
   `node scripts/adjuster-core-run.mjs --call calls/<name>/call.json --format json --verbose`
   and lift the response bodies out of the log, or copy them from the call
   folder in Drive.
3. Generate `expected-validated.json` by running the fixture through core with
   the recorded responses, then **read it** before committing. The expected file
   is the assertion; a wrong one locks in a bug.

## Fixture inventory

| Fixture                   | Kind      | What it pins                                                                                                                      |
| ------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `synthetic-hail-roof`     | synthetic | Three sources, merge accepted at full verbatim coverage, extraction off the master, both property backstops firing, unplaced note |
| `synthetic-single-source` | synthetic | One source, merge skipped entirely, extraction off the raw fallback, three fields landing on NEEDS INPUT                          |

### Status: the real calls are still to come

**Both fixtures above are synthetic.** The names, addresses, carriers, claim
numbers, and spoken words in them are invented. They exist so the harness has
something to run and is genuinely exercised on every push — they are not
anonymized recordings of anything, and nothing about them should be read as
evidence of how a real call behaves.

Spec 021 calls for five to ten real, anonymized calls, and its Open Question 2
(“which calls, and who anonymizes them”) is unresolved. That is the remaining
work here, and it needs source recordings someone has to supply:

- Pick five to ten calls that between them cover the paths that actually break:
  a rejected master, a two-source degraded merge, an ambiguous claim match, a
  call with no live export, a coverage-undetermined draft.
- Anonymize at fixture-creation time and review each one by hand before it is
  committed. Names, addresses, carriers, claim numbers, phone numbers, and
  policy numbers all have to go, consistently, across the transcript, the claim
  row, and the recorded responses.
- Transcripts only. No recordings and no raw Drive artifacts land here.

Adding those is additive: drop each directory in and `corpus.test.ts` picks it
up automatically.
