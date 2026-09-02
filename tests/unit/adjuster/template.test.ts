import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const enumsPath = path.resolve(process.cwd(), 'apps/adjuster/template/enums.json')
const templatePath = path.resolve(process.cwd(), 'apps/adjuster/template/template.flattened.txt')

const enums = JSON.parse(readFileSync(enumsPath, 'utf-8')) as Record<string, TagSchema>
const templateText = readFileSync(templatePath, 'utf-8')

type VariantOption = { key: string; label: string; text: string }
type TagSchema = {
  label: string
  type: 'date' | 'string' | 'enum' | 'narrative' | 'variant'
  section: string
  required: boolean
  requiredWhen?: { field: string; equals: string }
  values?: string[] | VariantOption[]
}

function tagsIn(text: string): Set<string> {
  const matches = text.matchAll(/{{(\w+)}}/g)
  return new Set(Array.from(matches, (m) => m[1]))
}

// Variant-type tags resolve to stored paragraph text at doc-generation time, which can
// itself reference other tags (e.g. coverage_determination's text references loss_cause).
// Those nested references never appear in template.flattened.txt directly, so the parity
// check must also scan every variant option's text.
function nestedVariantTags(schema: Record<string, TagSchema>): Set<string> {
  const found = new Set<string>()
  Object.values(schema).forEach((tag) => {
    if (tag.type !== 'variant') return
    ;(tag.values as VariantOption[]).forEach((option) => {
      tagsIn(option.text).forEach((t) => found.add(t))
    })
  })
  return found
}

describe('adjuster template / enums parity', () => {
  it('has a schema entry for every {{tag}} in the flattened template body', () => {
    const bodyTags = tagsIn(templateText)
    const missing = Array.from(bodyTags).filter((tag) => !(tag in enums))
    expect(missing).toEqual([])
  })

  it('has a schema entry for every {{tag}} referenced inside a variant option', () => {
    const nested = nestedVariantTags(enums)
    const missing = Array.from(nested).filter((tag) => !(tag in enums))
    expect(missing).toEqual([])
  })

  it('places every enums.json entry somewhere — the body or a variant option', () => {
    const bodyTags = tagsIn(templateText)
    const nested = nestedVariantTags(enums)
    const placed = new Set([...bodyTags, ...nested])

    const unplaced = Object.keys(enums).filter((tag) => !placed.has(tag))
    expect(unplaced).toEqual([])
  })

  it('gives every enum and variant tag a non-empty values list', () => {
    Object.entries(enums).forEach(([tag, schema]) => {
      if (schema.type === 'enum' || schema.type === 'variant') {
        expect(schema.values, `${tag} should have values`).toBeDefined()
        expect((schema.values as unknown[]).length).toBeGreaterThan(0)
      }
    })
  })

  it('gives every variant option a key, label, and text (text may be an intentionally empty string, e.g. mitigation_status "none", to drop a whole section)', () => {
    Object.entries(enums).forEach(([tag, schema]) => {
      if (schema.type !== 'variant') return
      ;(schema.values as VariantOption[]).forEach((option) => {
        expect(option.key, `${tag} option missing key`).toBeTruthy()
        expect(option.label, `${tag} option ${option.key} missing label`).toBeTruthy()
        expect(typeof option.text, `${tag} option ${option.key} missing text`).toBe('string')
      })
    })
  })

  it('gives every tag a label, type, section, and explicit required flag', () => {
    Object.entries(enums).forEach(([tag, schema]) => {
      expect(schema.label, `${tag} missing label`).toBeTruthy()
      expect(schema.type, `${tag} missing type`).toBeTruthy()
      expect(schema.section, `${tag} missing section`).toBeTruthy()
      expect(typeof schema.required, `${tag} missing explicit required flag`).toBe('boolean')
    })
  })
})

// Phase 2: a variant branch with empty (or whitespace-only) text is a section
// that silently disappears — no heading, no sentence, no [NEEDS INPUT] flag —
// which is exactly the class of bug this spec fixes. mitigation_status "none"
// is the one known violation, fixed by Phase 6's canned "No mitigation
// services were performed on this loss." sentence; until that phase lands,
// resolveTagsForDoc's runtime backstop (see docgen.js) still keeps it from
// rendering as an invisible gap.
describe('schema lint: no variant option renders blank', () => {
  it('gives every variant option non-empty, non-whitespace-only text', () => {
    const violations: string[] = []
    Object.entries(enums).forEach(([tag, schema]) => {
      if (schema.type !== 'variant') return
      ;(schema.values as VariantOption[]).forEach((option) => {
        if (!option.text.trim()) violations.push(`${tag}.${option.key}`)
      })
    })
    expect(violations).toEqual([])
  })
})

// Fields referenced only inside one variant branch must be required exactly when that
// branch is chosen — otherwise a missing value renders as silent blank text (e.g.
// "mortgage is through .") instead of a [NEEDS INPUT] marker the reviewer can see.
describe('branch-dependent fields flag instead of rendering blank', () => {
  const branchFields: Record<string, { field: string; equals: string }> = {
    mitigation_narrative: { field: 'mitigation_status', equals: 'present' },
    coinsurance_narrative: { field: 'coinsurance_status', equals: 'applies' },
    interior_damage_narrative: { field: 'interior_status', equals: 'affected' },
    other_structures_narrative: { field: 'other_structures_status', equals: 'affected' },
  }

  Object.entries(branchFields).forEach(([tag, condition]) => {
    it(`${tag} is required when ${condition.field} is ${condition.equals}`, () => {
      expect(enums[tag].required).toBe(true)
      expect(enums[tag].requiredWhen).toEqual(condition)
    })
  })
})

// Phase 6: was/were folded into present_at_inspection, dwelling_stories no longer
// forces a closed enum, year_built and the per-side roof/exterior findings flag
// instead of silently rendering blank, and coinsurance has a canned "no" branch.
describe('Phase 6 field behavior', () => {
  it('has no separate was/were field — present_at_inspection is a full narrative sentence', () => {
    expect('present_at_inspection_verb' in enums).toBe(false)
    expect(enums.present_at_inspection.type).toBe('narrative')
  })

  it('does not force dwelling_stories into a closed enum', () => {
    expect(enums.dwelling_stories.type).not.toBe('enum')
    expect(enums.dwelling_stories.values).toBeUndefined()
  })

  it('requires year_built so a blank does not silently omit', () => {
    expect(enums.year_built.required).toBe(true)
  })

  it('requires soft metals plus every per-slope and per-elevation status field so a missing component flags', () => {
    ;[
      'soft_metal_status',
      'front_slope_status',
      'right_slope_status',
      'back_slope_status',
      'left_slope_status',
      'front_elevation_status',
      'right_elevation_status',
      'back_elevation_status',
      'left_elevation_status',
    ].forEach((tag) => {
      expect(enums[tag].required, `${tag} should be required`).toBe(true)
    })
  })

  it('gives coinsurance a canned no-penalty branch, not a forced NEEDS INPUT', () => {
    expect(enums.coinsurance_status.type).toBe('variant')
    const keys = (enums.coinsurance_status.values as VariantOption[]).map((o) => o.key)
    expect(keys).toEqual(['no_coinsurance', 'applies'])
    const noCoinsurance = (enums.coinsurance_status.values as VariantOption[]).find(
      (o) => o.key === 'no_coinsurance',
    )
    expect(noCoinsurance?.text).toBeTruthy()
  })
})

// [DATE_RECEIVED], [DATE_CONTACTED], [DATE_INSPECTED], [DATE_LOSS] are Ibis's own
// merge-field tokens from the original blank template, not fields our voice-to-report
// pipeline extracts or fills. They must stay as literal square-bracket text in the
// flattened template and must never become {{tags}} the LLM is asked to populate.
describe('Ibis merge-field tokens (not ours to fill)', () => {
  const ibisTokens = ['[DATE_RECEIVED]', '[DATE_CONTACTED]', '[DATE_INSPECTED]', '[DATE_LOSS]']

  it('preserves every Ibis merge-field token as literal text in the flattened template', () => {
    ibisTokens.forEach((token) => {
      expect(templateText, `${token} missing from template.flattened.txt`).toContain(token)
    })
  })

  it('never schemas a field for what an Ibis merge-field token already covers', () => {
    ;['date_received', 'date_contacted', 'date_inspected', 'date_of_loss'].forEach((tag) => {
      expect(tag in enums, `${tag} should not be an extractable field`).toBe(false)
    })
  })
})

// An adjuster who has not reached a coverage call yet is the ordinary middle
// case, not a gap. Forcing covered/excluded made the model pick one, which is
// the single worst thing a coverage sentence can get wrong.
describe('undetermined coverage', () => {
  const options = enums.coverage_determination.values as VariantOption[]
  const unknown = options.find((o) => o.key === 'unknown')

  it('offers an unknown branch alongside covered and excluded', () => {
    expect(options.map((o) => o.key)).toEqual(['covered', 'excluded', 'unknown'])
  })

  it('renders the questionable-coverage wording and carries any detail given', () => {
    expect(unknown?.text).toContain('coverage is questionable at this time.')
    expect(unknown?.text).toContain('{{coverage_supporting_detail}}')
  })

  it('always flags for manual input, since an unresolved coverage call cannot be filed as-is', () => {
    expect(unknown?.text).toMatch(/\[NEEDS INPUT:[^\]]*\]/)
  })
})

// Real reports write the interior as one block per room rather than one running
// paragraph, so a reviewer can find a room and the estimate written against it.
describe('room-grouped interior and other structures', () => {
  const interiorOptions = enums.interior_status.values as VariantOption[]
  const otherOptions = enums.other_structures_status.values as VariantOption[]

  it('gates the interior body behind a status variant, the way the roof and exterior already are', () => {
    expect(enums.interior_status.type).toBe('variant')
    expect(interiorOptions.map((o) => o.key)).toEqual(['not_affected', 'affected'])
  })

  it('carries the lead-in on the affected branch so an unaffected interior never prints a dangling header', () => {
    const affected = interiorOptions.find((o) => o.key === 'affected')
    expect(affected?.text).toContain('My inspection documented damages within the following areas:')
    expect(affected?.text).toContain('{{interior_damage_narrative}}')
    expect(interiorOptions.find((o) => o.key === 'not_affected')?.text).not.toContain('{{')
  })

  it('keeps the existing no-damage sentence as the other-structures default', () => {
    expect(otherOptions.find((o) => o.key === 'none')?.text).toBe(
      "Inspection found no storm related damages to any of the insured's other structures.",
    )
  })

  it('lists damaged other structures the same way the interior lists rooms', () => {
    const affected = otherOptions.find((o) => o.key === 'affected')
    expect(affected?.text).toContain('{{other_structures_narrative}}')
  })

  it('replaces the hardcoded other-structures sentence in the body with the tag', () => {
    expect(templateText).toContain('{{other_structures_status}}')
    expect(templateText).not.toContain(
      "Inspection found no storm related damages to any of the insured's other structures.",
    )
  })
})

// A half bath and a seven-bedroom house are both real answers. A closed 1-6 enum
// silently dropped them at the set-membership check and left the field blank.
describe('property counts are not closed enums', () => {
  ;['bedroom_count', 'bathroom_count'].forEach((tag) => {
    it(`does not force ${tag} into a closed enum`, () => {
      expect(enums[tag].type).not.toBe('enum')
      expect(enums[tag].values).toBeUndefined()
    })
  })
})
