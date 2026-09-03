// The runtime-agnostic half of the adjuster pipeline — see docs/specs/021 and
// docs/adr/009-adjuster-portable-core-contract.md.
//
// Everything under src/core/ is portable: it touches no Apps Script global, it
// reads no per-client configuration of its own, and it performs no I/O beyond
// the injected `deps.fetch`. Google Docs rendering, Sheets storage, Drive
// artifacts, and Calendar seeding live one directory up as adapters that call
// in here. A second client reuses this directory unchanged and writes their own
// adapters against the contract stated in the ADR.
//
// Two rules hold this boundary, both enforced by tests/unit/adjuster/coreBoundary.test.ts:
//
//   1. No file here may name an Apps Script global (DriveApp, SpreadsheetApp,
//      PropertiesService, UrlFetchApp, Utilities, ...).
//   2. No file here may reference a cross-file symbol that is not defined under
//      core/ or on the guard's short declared allowlist. This is the rule that
//      catches an indirect leak — a core file calling logEvent(), which calls
//      appendRaw(), which reaches SpreadsheetApp, without ever naming one.
//
// Apps Script concatenates every file in the project into one global scope, so
// this directory is a boundary maintained by the guard test rather than by a
// module system. There is no bundler and no import statement anywhere here.

var ADJUSTER_CORE_CONTRACT_VERSION = '1'

// The stated contract, as one object. Every entry forwards to a plain function
// defined under core/, so this is a naming convenience rather than a layer — an
// adapter may call core.extract(...) or coreExtract(...) and get the same
// behaviour.
//
// Each entry is a wrapper rather than a direct reference on purpose. Apps
// Script runs top-level `var` initialisers in file order, and while function
// declarations do hoist across the concatenated script, a direct reference here
// would make this file the one place in the project where that has to be true.
// A wrapper does not dereference its target until it is called, so this
// initialiser is a plain object literal and the move cannot reorder an
// initialisation dependency — the property docs/adr/009's "Deploy impact"
// section relies on.
var core = {
  // Given audio, produce the source transcripts.
  transcribe: function (input) {
    return coreTranscribe(input)
  },

  // The pipeline proper, in one call.
  run: function (input) {
    return coreRun(input)
  },

  // The steps coreRun composes. An adapter that has to split the pipeline
  // across executions calls these directly.
  match: function (input) {
    return coreResolveMatch(input)
  },
  needsLlmMatch: function (match) {
    return coreNeedsLlmClaimMatch(match)
  },
  resolveLlmMatch: function (input) {
    return coreResolveLlmMatch(input)
  },
  merge: function (input) {
    return coreMergeSources(input)
  },
  buildExtractionHints: function (input) {
    return coreBuildExtractionHints(input)
  },
  parseCalendarFields: function (claim, deps) {
    return coreParseCalendarFields(claim, deps)
  },
  extract: function (input) {
    return coreExtract(input)
  },
  validate: function (input) {
    return coreValidate(input)
  },
  buildKeyterms: function (claim, glossary, adjusterName) {
    return buildKeyterms(claim, glossary, adjusterName)
  },
}
