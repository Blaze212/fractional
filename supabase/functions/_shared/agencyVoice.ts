// Agency voice style guide for the submittal-fit narrative.
//
// Framework-agnostic: a pure string constant with no Deno or Node APIs so it
// can be imported by both the Deno edge function (via agencyConfig.ts) and the
// Node-based Promptfoo eval provider (tests/eval/provider.ts). Keep prompt
// wording here and nowhere else.

export const FIT_NARRATIVE_STYLE_GUIDE = `
AGENCY VOICE:
- Write in a professional, values-grounded tone that is direct and efficient — no filler phrases, no superlatives unsupported by the profile.
- Lead with the candidate's clearest differentiator for this role, then support with specifics.
- Prefer precise, active language ("led a 12-person team" not "strong leadership background").
- Each bullet should read as a complete, standalone argument a hiring manager can absorb without re-reading the profile.
- Avoid recruiting clichés: "proven track record", "results-driven", "passionate", "dynamic", "seasoned".
- Keep sentences tight: one strong claim per sentence, two sentences per bullet maximum.
- The fit_summary should frame the candidate as a deliberate, aligned fit — not a generic strong candidate.
`.trim()
