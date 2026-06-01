import type { JsonSchema } from '../_shared/ai-client.ts'

export interface FitBullet {
  text: string
  source_ref: string
}

export type FitLevel = 'strong' | 'moderate' | 'weak' | 'not_recommended'

export interface MustHaveCoverage {
  requirement: string
  met: boolean
  evidence: string | null
}

export interface FitResult {
  // client-facing
  fit_bullets: FitBullet[]
  fit_summary: string
  key_qualifications: FitBullet[]
  // internal / assessment
  jd_must_haves: string[]
  must_have_coverage: MustHaveCoverage[]
  fit_level: FitLevel
  internal_assessment: { gaps: string[] }
}

const fitBulletItem = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    source_ref: { type: 'string' },
  },
  required: ['text', 'source_ref'],
  additionalProperties: false,
}

const mustHaveCoverageItem = {
  type: 'object',
  properties: {
    requirement: { type: 'string' },
    met: { type: 'boolean' },
    evidence: { type: ['string', 'null'] },
  },
  required: ['requirement', 'met', 'evidence'],
  additionalProperties: false,
}

export const FIT_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    fit_bullets: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: fitBulletItem,
    },
    fit_summary: { type: 'string' },
    key_qualifications: {
      type: 'array',
      minItems: 0,
      maxItems: 5,
      items: fitBulletItem,
    },
    jd_must_haves: {
      type: 'array',
      items: { type: 'string' },
    },
    must_have_coverage: {
      type: 'array',
      items: mustHaveCoverageItem,
    },
    fit_level: {
      type: 'string',
      enum: ['strong', 'moderate', 'weak', 'not_recommended'],
    },
    internal_assessment: {
      type: 'object',
      properties: {
        gaps: { type: 'array', items: { type: 'string' } },
      },
      required: ['gaps'],
      additionalProperties: false,
    },
  },
  required: [
    'fit_bullets',
    'fit_summary',
    'key_qualifications',
    'jd_must_haves',
    'must_have_coverage',
    'fit_level',
    'internal_assessment',
  ],
  additionalProperties: false,
}
