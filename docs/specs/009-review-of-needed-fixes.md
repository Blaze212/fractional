Code Review — feature/specs-1-4 (PR #1)

Greenfield foundation review — engineering + business-owner lens. This is the first review on the project, so I've weighted the assessment
toward the foundation (patterns that 50 future PRs will inherit) and toward the one thing the whole product is being sold on: trustworthy,
fact-grounded submittals.

What this ships

The "Resume-to-Submittal Auto-Formatter" wedge, end to end:

- resume-parse edge fn — pasted résumé text → typed ParsedProfile (one OpenAI Responses call, stateless, no persistence).
  qualifications, with a deterministic anti-hallucination guard.
- Portal page — recruiter pastes résumé + JD + client/role → Generate → edits every field → exports an agency-branded .docx (client-side
  Docxtemplater + logo injection).
- Shared infra (auth/errors/logger/ai-client), per-user logo storage, agency branding, ADRs 001–004, a Promptfoo eval suite (spec 006,
  implemented — tests/eval/ + eval:submittal script), and ~147 unit/component tests.

Foundation: genuinely strong ✅

Credit where due — this is a clean base:

interface, so the logic is testable without network. This is the right shape.

- Project rules respected: verify_jwt = false for all three functions with in-function withAuth() (ES256); no Deno.serve() is imported across
  modules (isolation rule); CORS uses an origin allowlist; errors/logs never echo résumé text (metadata only).
- Trust scaffolding is present: source_ref provenance is surfaced in the UI (ResumeTemplaterPage.tsx:133), every generated + recruiter field
  is editable before export, and the deterministic guard backs up the prompt. The intent is right.
- ADRs filed; the stateless/no-PII-retention decision for the core flow is honored.

---

Findings

🔴 1. The anti-hallucination guard is weaker than the ADR claims — both directions (HIGH, business-critical)

This is the core selling point ("a fabricated metric is a reputational/legal liability"), so it deserves the harshest scrutiny.
findUnsupportedNumbers (submittal-fit.ts:97-131) checks each output number as a substring of JSON.stringify(profile). I ran the actual code:

False negatives — fabricated numbers slip through:
"Led a team of 40 people" -> token "40" -> PASSES (profile had "$140k"; "140k" contains "40")
Any bare integer that happens to be a substring of any number in the profile JSON — and the haystack is the full profile including phone
numbers, zip codes, and employment years (2014, 2023…) — is accepted. Fabricated percentages/counts that coincide with a year digit-run pass
routinely. The ADR says the guard "favours false-positive caution"; the substring approach actually produces false negatives, which is the
dangerous direction for this business.

False positives — clean output gets blocked:
"Managed 7 key accounts" -> token "7k"
"Led 3 major initiatives" -> token "3m"
"Built 5 brand campaigns" -> token "5b"
The regex (\d…\s?(?:%|k|m|b|x|…)) greedily attaches a following word that starts with k/m/b/x, manufacturing a fake unit. When the source
spells a number out (or phrases it differently) and the model writes digits, these trip a spurious 422 → "contained figures not present…
Please regenerate." That directly erodes the "it just works on day one" promise.

Also: the prompt shows the model a trimmed serializeProfile view, but the guard validates against the full JSON (email/phone/education years)
— so the guard "supports" numbers the model never even saw.

The unit tests cover only obvious cases (8m, 400%) and so give false confidence — neither failure mode above is tested. Recommendations: (a)
tokenize with word boundaries and require a real adjacent unit/%/$; (b) build the haystack from the same fact view the model receives,
restricted to fields that can legitimately carry metrics; (c) add the two cases above as regression tests; (d) reconcile the ADR's "favours
false-positives" claim with reality.

🔴 2. Export failure nukes the recruiter's work and forces a full re-generate (HIGH, UX)

handleExport's catch sets pageState='error' (ResumeTemplaterPage.tsx:302). Because showInputs = idle || error, the entire success view
unmounts and the button becomes "Try Again" → handleGenerate (:398). So a transient blip fetching /submittal-template.docx discards the
visible result and the only path forward is a brand-new LLM generation — losing every edit the recruiter just made and re-billing two model
calls. Export errors should surface inline on the success screen and let the user simply retry the export.

🟠 3. Agency identity is hardcoded and the voice lives in 3 divergent copies (MEDIUM — directly hits the "customize per agency" goal)

- submittal-fit/system-prompt.ts:6 hardcodes "Aligned Recruitment" into BASE_PROMPT.
- \_shared/agencyConfig.ts:23 says name: 'Agency Name' (placeholder), while the frontend agencyConfig.ts:46 says 'Aligned Recruitment'.
- The fit-narrative style guide now exists in three places with different wording: agencyVoice.ts (the spec-006 "single source"), the frontend
  agencyConfig.ts:64 (its own copy, names the agency), and inline in BASE_PROMPT. Spec 006 explicitly introduced agencyVoice.ts to prevent
  exactly this drift.

For a lead magnet meant to be "lightly customized per agency," onboarding a second agency currently means editing prompt source in multiple
files and hoping they stay consistent. Consolidate to one source and route per-agency overrides through the user_agency_configs table you
already built.

🟠 4. Spec/ADR drift — "no persistence/no migrations" is no longer true (MEDIUM, docs)

Spec 005 and ADR 004 state, as a load-bearing decision, "No persistence / no database changes… no migrations." But the branch adds
20260601000000_user_agency_configs.sql (a persisted per-user JSONB config with RLS) and the output schema grew a key_qualifications field that
appears in neither spec 005 nor ADR 004. The code is fine; the records are stale. On a greenfield repo the ADRs are the institutional memory
— update ADR 004 (or add 005) to record the persistence reversal and the schema addition, so the next engineer isn't misled.

🟡 5. Smaller items (LOW)

- unknown in \_shared/logger.ts:27 technically violates the project's "ask before using unknown" rule. It's a defensible pino-style normalizer,
  but flagging per the rule. (The as any in ai-client.ts are deno-lint-ignored for the Responses SDK typing gap — acceptable and commented.)
- key={i} on the editable bullet lists (:472, :488) — harmless here (fixed length, never reordered) but worth a stable key if the list ever
  becomes dynamic.
- Hardcoded /submittal-template.docx path (:261) — fine, just make it a named constant.
- Tests could not be executed in this environment (@rollup/rollup-linux-arm64-gnu missing — the known sandbox arch issue per CLAUDE.md). CI
  must be the gate. Test density is good (~147), and the grounding/exactly-3/422 paths are covered — but see #1: the coverage misses the actual
  failure modes.

---

Business-owner lens (against the $100M Leads "result-in-advance asset")

The asset has to do three jobs: deliver an obvious day-one win, be safe to send to a real client, and produce the "time-saved" proof for the
results-call upsell. Mapping the findings:

1. Trust is the whole pitch — and it's the weakest link. Finding #1 cuts both ways against the sales motion: a fabricated number reaching a
   hiring manager ends the relationship and the audit upsell, while spurious "figures not present" errors (false positives) undercut the "30
   seconds, just works" promise on the install call. This is the one thing I'd fix before putting it in front of a founder. The mandatory
   human-edit step is a real backstop, but it's currently the backstop for all non-numeric fabrication (invented employer/title/"led the IPO") —
   which is by design, but means your demo script must lean on "you always review before sending," not "it can't hallucinate."
2. Per-agency customization friction (Finding #3) fights the wedge model. The plan is "build once, lightly customize per agency." Today the
   agency name and voice are baked into prompt source in inconsistent spots, so each new install is a code edit, not a config change. You already
   shipped user_agency_configs — make that the customization surface and the install call becomes a 5-minute config, not a deploy.
3. The "results call" proof is not yet built — and the plan depends on it. Your own outreach motion promises a report: "# of runs, hours
   saved." The MVP is intentionally stateless and only emits pino logs; there's no per-run persistence or minutes-saved counter. That's not a bug
   (it's scoped out), but it's the missing piece that converts a free install into the paid Workflow Audit. I'd put "log each run + estimated
   minutes saved to a sheet/table" as the very next spec — it's low effort and it's literally the upsell mechanism.
4. Intake is paste-only. The full vision's trigger is "new candidate added (email/folder/ATS)." Paste-only is the right MVP scope, but be
   explicit on the install call that the auto-trigger is the "later build," so the founder's expectation matches what fires.

---

Verdict

A strong, well-structured greenfield foundation — approve after addressing #1 and #2. The architecture, auth, separation, and test discipline
are better than typical for a first PR and will age well. But the product is sold on trustworthy submittals, and the grounding guard (#1) is
demonstrably leaky in both directions, while the export-failure flow (#2) can silently destroy a recruiter's edits. Those two are the
difference between "a tool I'd hand a founder" and "a demo that burns a lead." #3–#4 are fast follow-ups; the run/time-saved tracking is the
highest-leverage next thing for the business, not this PR.

Want me to (a) tighten findUnsupportedNumbers + add the two regression tests, (b) fix the export-retry flow, or (c) open a spec for
run/time-saved tracking? I can take any subset.
