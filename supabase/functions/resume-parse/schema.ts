import type { JsonSchema } from '../_shared/ai-client.ts'

export interface SelectedExperience {
  company: string | null
  title: string | null
  start_date: string | null
  end_date: string | null
  responsibilities: string[]
  achievements: string[]
}

export interface OtherExperience {
  company: string | null
  title: string | null
  start_date: string | null
  end_date: string | null
}

export interface Education {
  institution: string | null
  degree: string | null
}

export interface Certification {
  provider: string | null
  certification: string | null
}

export interface ParsedProfile {
  name: string | null
  email: string | null
  phone: string | null
  location: string | null
  linkedin_url: string | null
  current_title: string | null
  work_authorization: string | null
  total_experience: string | null
  summary: string | null
  career_highlights: string[]
  selected_experience: SelectedExperience[]
  other_experience: OtherExperience[]
  education: Education[]
  certifications: Certification[]
  skills: string[]
  tools: string[]
  seniority_level: string | null
  functional_areas: string[]
  industries: string[]
}

const nullable = (type: string) => ({ anyOf: [{ type }, { type: 'null' }] })

const selectedExperienceItem = {
  type: 'object',
  properties: {
    company: nullable('string'),
    title: nullable('string'),
    start_date: nullable('string'),
    end_date: nullable('string'),
    responsibilities: { type: 'array', items: { type: 'string' } },
    achievements: { type: 'array', items: { type: 'string' } },
  },
  required: ['company', 'title', 'start_date', 'end_date', 'responsibilities', 'achievements'],
  additionalProperties: false,
}

const otherExperienceItem = {
  type: 'object',
  properties: {
    company: nullable('string'),
    title: nullable('string'),
    start_date: nullable('string'),
    end_date: nullable('string'),
  },
  required: ['company', 'title', 'start_date', 'end_date'],
  additionalProperties: false,
}

const educationItem = {
  type: 'object',
  properties: {
    institution: nullable('string'),
    degree: nullable('string'),
  },
  required: ['institution', 'degree'],
  additionalProperties: false,
}

const certificationItem = {
  type: 'object',
  properties: {
    provider: nullable('string'),
    certification: nullable('string'),
  },
  required: ['provider', 'certification'],
  additionalProperties: false,
}

export const PARSED_PROFILE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    name: nullable('string'),
    email: nullable('string'),
    phone: nullable('string'),
    location: nullable('string'),
    linkedin_url: nullable('string'),
    current_title: nullable('string'),
    work_authorization: nullable('string'),
    total_experience: nullable('string'),
    summary: nullable('string'),
    career_highlights: { type: 'array', items: { type: 'string' } },
    selected_experience: { type: 'array', items: selectedExperienceItem },
    other_experience: { type: 'array', items: otherExperienceItem },
    education: { type: 'array', items: educationItem },
    certifications: { type: 'array', items: certificationItem },
    skills: { type: 'array', items: { type: 'string' } },
    tools: { type: 'array', items: { type: 'string' } },
    seniority_level: nullable('string'),
    functional_areas: { type: 'array', items: { type: 'string' } },
    industries: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'name',
    'email',
    'phone',
    'location',
    'linkedin_url',
    'current_title',
    'work_authorization',
    'total_experience',
    'summary',
    'career_highlights',
    'selected_experience',
    'other_experience',
    'education',
    'certifications',
    'skills',
    'tools',
    'seniority_level',
    'functional_areas',
    'industries',
  ],
  additionalProperties: false,
}
