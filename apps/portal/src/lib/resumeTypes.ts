// Shared ParsedProfile type — mirrors the spec 001 schema
// Used by both resumeExport.ts and ResumeTemplaterPage.tsx

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
