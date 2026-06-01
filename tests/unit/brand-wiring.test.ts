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

describe('brand color wiring', () => {
  it('uses the muted brand color as a page background on both pages', () => {
    expect(settings).toContain('bg-brand-muted')
    expect(templater).toContain('bg-brand-muted')
  })

  it('uses the secondary brand color for secondary text on both pages', () => {
    expect(settings).toContain('text-brand-secondary')
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

describe('agency logo in headers', () => {
  it('renders the AgencyLogoMark in both page headers instead of the raw agency name', () => {
    expect(settings).toContain('<AgencyLogoMark')
    expect(templater).toContain('<AgencyLogoMark')
    // The templater header no longer hard-codes the name as an <h1>.
    expect(templater).not.toContain('>{config.identity.name}</h1>')
  })

  it('hosts the logo uploader on the settings page, not the templater page', () => {
    expect(settings).toContain('<LogoUploader')
    expect(templater).not.toContain('<LogoUploader')
  })
})
