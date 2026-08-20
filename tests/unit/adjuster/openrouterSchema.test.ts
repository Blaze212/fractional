import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { buildExtractionSchema } = loadGs('apps/adjuster/src/llm/openrouter.js')

const SPEC = {
  loss_date: { type: 'date', label: 'Loss date' },
  coverage_determination: { type: 'variant', label: 'Coverage' },
}

function everyObject(node: any, seen: any[] = []): any[] {
  if (!node || typeof node !== 'object') return seen
  if (node.type === 'object') seen.push(node)
  Object.values(node).forEach((child) => everyObject(child, seen))
  return seen
}

describe('buildExtractionSchema', () => {
  it('marks every object closed, which strict mode rejects the request without', () => {
    const objects = everyObject(buildExtractionSchema(SPEC))

    expect(objects.length).toBeGreaterThan(0)
    objects.forEach((node) => expect(node.additionalProperties).toBe(false))
  })

  it('lists every property of every object in required', () => {
    everyObject(buildExtractionSchema(SPEC)).forEach((node) => {
      expect(node.required.slice().sort()).toEqual(Object.keys(node.properties).sort())
    })
  })

  it('types every extracted value, since an untyped value is not valid under strict mode', () => {
    const schema = buildExtractionSchema(SPEC)

    Object.keys(SPEC).forEach((tag) => {
      expect(schema.properties.fields.properties[tag].properties.value).toEqual({ type: 'string' })
    })
  })

  it('requires a field entry for every tag in the template spec', () => {
    const schema = buildExtractionSchema(SPEC)

    expect(schema.properties.fields.required).toEqual(['loss_date', 'coverage_determination'])
  })
})

describe('provider routing', () => {
  it('requires endpoints that support the requested parameters', () => {
    const src = readFileSync('apps/adjuster/src/llm/openrouter.js', 'utf-8')

    expect(src).toContain('require_parameters: true')
  })
})
