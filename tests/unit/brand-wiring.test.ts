import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// These pages pull in react-router-dom, which pnpm only links inside the portal
// workspace (not the repo root where this shared vitest config runs), so we
// guard the brand wiring at the source level. This locks in that the secondary
// and muted brand colors are actually consumed by the UI — the regression this
// suite exists to prevent ("it looked wired up but never applied").

function read(relativeToRepoRoot: string): string {
  return readFileSync(resolve(process.cwd(), relativeToRepoRoot), 'utf8')
}

const settings = read('apps/portal/src/pages/SettingsPage.tsx')
const templater = read('apps/portal/src/pages/ResumeTemplaterPage.tsx')
const appHeader = read('apps/portal/src/components/AppHeader.tsx')

describe('brand color wiring', () => {
  it('uses the muted brand color as a page background on both pages', () => {
    expect(settings).toContain('bg-brand-muted')
    expect(templater).toContain('bg-brand-muted')
  })

  it('uses the secondary brand color for secondary text', () => {
    expect(templater).toContain('text-brand-secondary')
  })

  it('no longer flags the Secondary or Muted Background fields as "not applied"', () => {
    // The Secondary and Muted fields previously carried a `notApplied` badge.
    // The only remaining notApplied usages must be unrelated fields.
    const secondaryField = settings.slice(
      settings.indexOf('label="Secondary"'),
      settings.indexOf('label="Muted Background"') + 200,
    )
    expect(secondaryField).not.toContain('notApplied')
  })
})

describe('settings cleanup', () => {
  it('removes every "not applied" setting and the badge component', () => {
    expect(settings).not.toContain('notApplied')
    expect(settings).not.toContain('NotApplied')
    expect(settings).not.toContain('not applied')
  })

  it('drops the dead config fields entirely', () => {
    for (const field of [
      'shortName',
      'tagline',
      'resumeFileStem',
      'pageTitle',
      'uploadPrompt',
      'successHeading',
      'generateButtonLabel',
    ]) {
      expect(settings).not.toContain(field)
    }
  })
})

describe('LLM style guide wiring', () => {
  it('makes the style guide editable and bound to the draft config', () => {
    // Editable means it writes back to the draft via patch('llm', ...) and is
    // no longer a read-only mirror of the server file.
    expect(settings).toContain("patch('llm', { fitNarrativeStyleGuide:")
    expect(settings).toContain('draft.llm.fitNarrativeStyleGuide')
    const styleSection = settings.slice(settings.indexOf('LLM Style Guide'))
    expect(styleSection).not.toContain('readOnly')
    expect(settings).not.toContain('_shared/agencyConfig.ts')
  })

  it('passes the saved style guide to submittal-fit so no redeploy is needed', () => {
    expect(templater).toContain('fit_narrative_style_guide: config.llm.fitNarrativeStyleGuide')
  })
})

describe('unified header', () => {
  it('uses the shared AppHeader on both pages', () => {
    expect(settings).toContain('<AppHeader')
    expect(templater).toContain('<AppHeader')
    // The templater header no longer hard-codes the name as an <h1>.
    expect(templater).not.toContain('>{config.identity.name}</h1>')
  })

  it('renders the agency logo mark inside the shared header', () => {
    expect(appHeader).toContain('<AgencyLogoMark')
  })

  it('hosts the logo uploader on the settings page, not the templater page', () => {
    expect(settings).toContain('<LogoUploader')
    expect(templater).not.toContain('<LogoUploader')
  })
})
