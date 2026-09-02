// The runtime-agnostic half of transcription. Its Drive-and-manifest half stays
// in apps/adjuster/src/transcription.js as an adapter — see docs/specs/021 and
// docs/adr/009-adjuster-portable-core-contract.md.
//
// Only the source-precedence block lives here so far. It arrived a phase early
// because core/masterTranscript.js reads SOURCE_PRECEDENCE and calls
// selectFallbackTranscript, and a core file reaching into an adapter file is
// exactly what the boundary guard rejects. The rest of the split follows.

// One ordering governs every degraded path: which source wins a disagreement
// inside the merge, and which source becomes the master when there is no usable
// merge. The job's own voice-platform transcript is last on wording
// (single-pass, real-time, lossy codec) and first on turn structure (it is the
// only source that knows when the agent spoke). Defined once, consumed by
// both the merge prompt and the fallback. The literal third slot below
// ('dograh') is this array's default/shape reference, used whenever a caller
// doesn't pass a per-job precedence — the real per-job precedence is built
// inline in runTranscriptionPass() as ['elevenlabs', 'qwen', voiceSource].
var SOURCE_PRECEDENCE = ['elevenlabs', 'qwen', 'dograh']

// Every "fall back" in spec 012 resolves through here, so the fallback order and
// the merge prompt's disagreement order can never drift apart.
function selectFallbackTranscript(sources, precedence) {
  var order = precedence || SOURCE_PRECEDENCE

  for (var i = 0; i < order.length; i++) {
    var name = order[i]
    var entry = (sources || {})[name]
    var text = entry ? String(entry.text || '') : ''
    if (text.trim()) return { source: name, text: text }
  }

  return { source: '', text: '' }
}

function availableSources(sources, precedence) {
  return (precedence || SOURCE_PRECEDENCE).filter(function (name) {
    var entry = (sources || {})[name]
    return entry && String(entry.text || '').trim()
  })
}
