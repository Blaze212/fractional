import { useState } from 'react'
import { useAgencyConfig, applyBrandCssVars } from '../contexts/AgencyConfigContext'
import type { AgencyConfig } from '../lib/agencyConfig'
import { AGENCY_CONFIG } from '../lib/agencyConfig'
import { AppHeader } from '../components/AppHeader'
import { LogoUploader } from '../components/LogoUploader'

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
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-slate-700">{label}</label>
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
              placeholder="Recruitment Agency"
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
        </section>

        {/* LLM Style Guide — editable; applied to the next submittal generation */}
        <section className="space-y-4">
          <SectionHeading>LLM Style Guide</SectionHeading>
          <p className="text-xs text-slate-500">
            Controls the agency voice injected into the AI fit-narrative prompt. Saved with your
            settings and applied to the next submittal you generate — no code change or redeploy
            needed. Leave blank to use the model&apos;s default tone.
          </p>
          <textarea
            value={draft.llm.fitNarrativeStyleGuide}
            onChange={(e) => patch('llm', { fitNarrativeStyleGuide: e.target.value })}
            rows={10}
            className="focus:border-brand focus:ring-brand w-full resize-y rounded-lg border border-slate-300 p-3 font-mono text-xs focus:outline-none focus:ring-1"
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
