import type { JsonSchema } from '../_shared/ai-client.ts'

export interface FitBullet {
  text: string
  source_ref: string
}

export interface FitResult {
  fit_bullets: FitBullet[]
  fit_summary: string
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
  },
  required: ['fit_bullets', 'fit_summary'],
  additionalProperties: false,
}
