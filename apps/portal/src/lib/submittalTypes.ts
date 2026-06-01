export type GradeAction = 'ship' | 'regenerate' | 'human_review'
export type FailureClass = 'hallucination' | 'structural' | 'none'

export interface FitGrade {
  action: GradeAction
  failure_class: FailureClass
  issues: string[]
  warnings: string[]
}

export interface MustHaveCoverage {
  requirement: string
  met: boolean
  evidence: string | null
}

export interface FitAssessment {
  fit_level: 'strong' | 'moderate' | 'weak' | 'not_recommended'
  jd_must_haves: string[]
  must_have_coverage: MustHaveCoverage[]
  gaps: string[]
}
