// Fixtures for docs/specs/022-adjuster-agent-suggestions-are-not-evidence.md.
//
// C1's raw transcript is quoted verbatim from the spec — it is the real
// opening of retell-call_4e034d77224863af06b4fc2577c (2026-09-07), the call
// that produced the wrong-claim report the spec exists to prevent. C1_MASTER
// reconciles the same exchange into the master-transcript label vocabulary.
//
// C2 and C3 are reconstructed rather than copied byte-for-byte: the actual
// recordings and pulled transcripts for retell-call_256aa200fdd679f4b7d680cb968
// and retell-call_d108ba13cf00804a35b458f5f10 live in production Drive/Sheets,
// not in this repository. Each is built to reproduce the shape the spec
// documents — C2 as an address-only deterministic win (score 60: street_number
// + street_name + city, no claim_number or insured_last_name signal, so
// identity/low) and C3 as a call with no identity signal at all — rather than
// reproducing the exact spoken words.

export const C1_RAW = [
  'Agent: Hi, I\'m here to record your field notes. Say "let\'s get started" to begin.',
  "User: Let's get started.",
  'Agent: Are you calling about the property on Maple Street in Locust for RAY?',
  'User: No.',
  "Agent: Sorry, didn't catch that. What's the property address, and what's the insured's last name?",
  'User: Property address is 1003 Venus Street, Kannapolis, North Carolina 28083. Insurance last name is Arnold.',
].join('\n')

export const C1_MASTER = [
  "agent: Hi, I'm here to record your field notes. Say let's get started to begin.",
  "adjuster: Let's get started.",
  'agent: Are you calling about the property on Maple Street in Locust for RAY?',
  'adjuster: No.',
  "agent: Sorry, didn't catch that. What's the property address, and what's the insured's last name?",
  'adjuster: Property address is 1003 Venus Street, Kannapolis, North Carolina 28083. Insurance last name is Arnold.',
].join('\n')

export const C2_RAW = [
  'Agent: Hi, I\'m here to record your field notes. Say "let\'s get started" to begin.',
  "User: Let's get started. I'm out at 1310 Airport Road in Monroe.",
  'Agent: Got it, go ahead with your notes.',
  'User: Roof is a 3-tab asphalt shingle, twelve years old.',
].join('\n')

export const C2_MASTER = [
  "agent: Hi, I'm here to record your field notes. Say let's get started to begin.",
  "adjuster: Let's get started. I'm out at 1310 Airport Road in Monroe.",
  'agent: Got it, go ahead with your notes.',
  'adjuster: Roof is a 3-tab asphalt shingle, twelve years old.',
].join('\n')

// No master exists for this call — stage B falls back to the raw platform
// transcript, same as the "only Dograh-shaped Agent:/User: fixture with no
// matching claim in the sheet" the spec describes.
export const C3_RAW = [
  'Agent: Hi, I\'m here to record your field notes. Say "let\'s get started" to begin.',
  "User: Let's get started. Roof looks fine, no storm damage found today.",
  'Agent: Understood, anything else to note?',
  "User: That's it for this one.",
].join('\n')

export function matchIntegrityClaims() {
  return [
    {
      claim_id: 'ray-1',
      insured_last_name: 'Ray',
      address_line1: '502 Maple Street',
      city: 'Locust',
      claim_number: 'CLM-100200',
      appt_end: '2026-09-07T15:00:00Z',
    },
    {
      claim_id: 'harris-1',
      insured_last_name: 'W.F. Harris Development',
      address_line1: '1310 Airport Road',
      city: 'Monroe',
      claim_number: 'CLM-778899',
      appt_end: '2026-09-07T15:00:00Z',
    },
    // Deliberately no Arnold / Venus Street row — the correct outcome for c1
    // after the fix is match_method: 'none'.
  ]
}

export const MATCH_INTEGRITY_CALL_STARTED_AT = '2026-09-07T15:10:00Z'
