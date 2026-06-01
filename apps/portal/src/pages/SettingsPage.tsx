import { useState } from 'react'
import { useAgencyConfig, applyBrandCssVars } from '../contexts/AgencyConfigContext'
import type { AgencyConfig } from '../lib/agencyConfig'
import { AGENCY_CONFIG } from '../lib/agencyConfig'
import { AppHeader } from '../components/AppHeader'
import { LogoUploader } from '../components/LogoUploader'

// Fields that are stored in config but not yet rendered anywhere in the app.
// Shown with a callout so we can decide to wire up or drop them.
function NotApplied({ label }: { label: string }) {
  return (
    <span
      title={label}
      className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700"
    >
      not applied
    </span>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="border-b border-slate-200 pb-2 text-sm font-semibold text-slate-900">
      {children}
    </h2>
  )
}

function Field({
  label,
  hint,
  notApplied,
  children,
}: {
  label: string
  hint?: string
  notApplied?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-slate-700">
        {label}
        {notApplied && <NotApplied label={`${label} is stored but not rendered in the app yet`} />}
      </label>
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
      {children}
    </div>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="focus:border-brand focus:ring-brand w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:outline-none focus:ring-1"
    />
  )
}

function ColorInput({
  value,
  onChange,
  label,
}: {
  value: string
  onChange: (v: string) => void
  label: string
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="h-9 w-14 cursor-pointer rounded border border-slate-300 p-0.5"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#000000"
        className="focus:border-brand focus:ring-brand w-28 rounded-lg border border-slate-300 p-2 font-mono text-sm focus:outline-none focus:ring-1"
      />
    </div>
  )
}

export default function SettingsPage() {
  const { config, saveConfig, resetConfig } = useAgencyConfig()
  const [draft, setDraft] = useState<AgencyConfig>(config)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function patch<K extends keyof AgencyConfig>(section: K, values: Partial<AgencyConfig[K]>) {
    setDraft((d) => ({ ...d, [section]: { ...d[section], ...values } }))
    setSaved(false)
    setSaveError(null)
  }

  // Brand color changes apply immediately for live preview — no need to save first.
  function patchBrand(values: Partial<AgencyConfig['brand']>) {
    const next = { ...draft.brand, ...values }
    setDraft((d) => ({ ...d, brand: next }))
    applyBrandCssVars(next)
    setSaved(false)
    setSaveError(null)
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      await saveConfig(draft)
      setSaved(true)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleReset() {
    if (!window.confirm('Reset all settings to the built-in defaults?')) return
    await resetConfig()
    setDraft(AGENCY_CONFIG)
    setSaved(false)
  }

  return (
    <div className="bg-brand-muted min-h-screen">
      <AppHeader maxWidthClass="max-w-2xl" />

      <main className="mx-auto max-w-2xl space-y-10 px-4 py-10">
        <h1 className="text-brand text-2xl font-bold">Settings</h1>

        {/* Identity */}
        <section className="space-y-4">
          <SectionHeading>Agency Identity</SectionHeading>
          <LogoUploader disabled={saving} />
          <Field label="Agency Name" hint="Shown in the page header when no logo is set.">
            <TextInput
              value={draft.identity.name}
              onChange={(v) => patch('identity', { name: v })}
              placeholder="Aligned Recruitment"
            />
          </Field>
          <Field label="Short Name" notApplied>
            <TextInput
              value={draft.identity.shortName}
              onChange={(v) => patch('identity', { shortName: v })}
              placeholder="Aligned"
            />
          </Field>
          <Field label="Tagline" notApplied>
            <TextInput
              value={draft.identity.tagline}
              onChange={(v) => patch('identity', { tagline: v })}
              placeholder="We make recruitment easy."
            />
          </Field>
        </section>

        {/* Brand Colors */}
        <section className="space-y-4">
          <SectionHeading>Brand Colors</SectionHeading>
          <p className="text-xs text-slate-400">
            Color changes preview instantly — click Save to persist.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Primary" hint="Buttons, links, header text.">
              <ColorInput
                label="Primary color"
                value={draft.brand.primary}
                onChange={(v) => patchBrand({ primary: v })}
              />
            </Field>
            <Field label="Primary Light" hint="Hover state for primary elements.">
              <ColorInput
                label="Primary light color"
                value={draft.brand.primaryLight}
                onChange={(v) => patchBrand({ primaryLight: v })}
              />
            </Field>
            <Field label="Secondary" hint="Accent color for subheadings and secondary text.">
              <ColorInput
                label="Secondary color"
                value={draft.brand.secondary}
                onChange={(v) => patchBrand({ secondary: v })}
              />
            </Field>
            <Field label="Muted Background" hint="Light page background tint.">
              <ColorInput
                label="Muted background color"
                value={draft.brand.muted}
                onChange={(v) => patchBrand({ muted: v })}
              />
            </Field>
          </div>
        </section>

        {/* Document Export */}
        <section className="space-y-4">
          <SectionHeading>Document Export</SectionHeading>
          <Field
            label="Sponsorship Text"
            hint="Printed beneath the candidate's name in the exported DOCX resume."
          >
            <TextInput
              value={draft.export.sponsorshipText}
              onChange={(v) => patch('export', { sponsorshipText: v })}
              placeholder="Authorized to work in the US without sponsorship"
            />
          </Field>
          <Field
            label="Submittal File Name"
            hint="Use {name} and {client}. E.g. {name}_for_{client}_submittal → Jane_Smith_for_Globex_submittal.docx"
          >
            <TextInput
              value={draft.export.submittalFileStem}
              onChange={(v) => patch('export', { submittalFileStem: v })}
              placeholder="{name}_for_{client}_submittal"
            />
          </Field>
          <Field
            label="Resume File Name"
            hint="Use {name}. E.g. {name}_resume → Jane_Smith_resume.docx"
            notApplied
          >
            <TextInput
              value={draft.export.resumeFileStem}
              onChange={(v) => patch('export', { resumeFileStem: v })}
              placeholder="{name}_resume"
            />
          </Field>
        </section>

        {/* UI Copy */}
        <section className="space-y-4">
          <SectionHeading>UI Copy</SectionHeading>
          <Field label="Generate Button Label">
            <TextInput
              value={draft.ui.generateButtonLabel}
              onChange={(v) => patch('ui', { generateButtonLabel: v })}
              placeholder="Generate Submittal"
            />
          </Field>
          <Field label="Page Title" notApplied hint="Would set the browser tab title.">
            <TextInput value={draft.ui.pageTitle} onChange={(v) => patch('ui', { pageTitle: v })} />
          </Field>
          <Field label="Success Heading" notApplied hint="Shown when the submittal is ready.">
            <TextInput
              value={draft.ui.successHeading}
              onChange={(v) => patch('ui', { successHeading: v })}
              placeholder="Submittal ready"
            />
          </Field>
          <Field label="Upload Prompt" hint="Subtitle shown below the page heading." notApplied>
            <textarea
              value={draft.ui.uploadPrompt}
              onChange={(e) => patch('ui', { uploadPrompt: e.target.value })}
              rows={2}
              className="focus:border-brand focus:ring-brand w-full resize-y rounded-lg border border-slate-300 p-2.5 text-sm focus:outline-none focus:ring-1"
            />
          </Field>
        </section>

        {/* LLM Style Guide — read-only; requires a code change + redeploy */}
        <section className="space-y-4">
          <SectionHeading>LLM Style Guide</SectionHeading>
          <p className="text-xs text-slate-500">
            Controls the agency voice injected into the AI fit-narrative prompt. Defined in{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
              supabase/functions/_shared/agencyConfig.ts
            </code>{' '}
            — requires a code change and redeploy to update.
          </p>
          <textarea
            readOnly
            value={config.llm.fitNarrativeStyleGuide}
            rows={10}
            className="w-full resize-y rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-500"
          />
        </section>

        {/* Actions */}
        <div className="flex items-center gap-4 border-t border-slate-200 pt-6">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="bg-brand hover:bg-brand-light rounded-lg px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
          {saved && <span className="text-sm text-emerald-600">Saved</span>}
          {saveError && <span className="text-sm text-red-600">{saveError}</span>}
          <button
            type="button"
            onClick={handleReset}
            className="ml-auto text-sm text-slate-400 hover:text-red-500"
          >
            Reset to defaults
          </button>
        </div>
      </main>
    </div>
  )
}
