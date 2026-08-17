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

  it('gives every variant option a key, label, and text', () => {
    Object.entries(enums).forEach(([tag, schema]) => {
      if (schema.type !== 'variant') return
      ;(schema.values as VariantOption[]).forEach((option) => {
        expect(option.key, `${tag} option missing key`).toBeTruthy()
        expect(option.label, `${tag} option ${option.key} missing label`).toBeTruthy()
        expect(option.text, `${tag} option ${option.key} missing text`).toBeTruthy()
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
