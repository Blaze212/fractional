import OpenAI from 'openai'
import { buildSubmittalSystemPrompt } from '../../supabase/functions/submittal-fit/system-prompt.ts'
import { buildSubmittalPrompt } from '../../supabase/functions/submittal-fit/prompt.ts'
import { FIT_RESULT_SCHEMA } from '../../supabase/functions/submittal-fit/schema.ts'
import type { SubmittalInput } from '../../supabase/functions/submittal-fit/submittal-fit.ts'

// The edge-function prompt builders and schema are imported directly. Their only
// runtime import is the pure agencyConfig -> agencyVoice chain; every other import
// in those files is `import type`, which is erased at load time — so no Deno.*
// globals are pulled in. The OpenAI call lives here (not in the Deno ai-client,
// which reads Deno.env) so the provider runs unchanged in Node.

interface ProviderContext {
  vars: SubmittalInput
}

// Provider entrypoint. Promptfoo instantiates this class once per provider
// (`new Provider({ id, config })`) and calls `callApi` for each test case.
export default class SubmittalFitProvider {
  private readonly providerId: string

  constructor(options: { id?: string } = {}) {
    this.providerId = options.id ?? 'submittal-fit'
  }

  id() {
    return this.providerId
  }

  async callApi(_prompt: string, context: ProviderContext) {
    const input = context.vars
    const systemPrompt = buildSubmittalSystemPrompt(input.fit_narrative_style_guide)
    const userPrompt = buildSubmittalPrompt(input)

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    // deno-lint-ignore no-explicit-any — Responses API typing matches ai-client.ts.
    const response = await (client as any).responses.create({
      model: 'gpt-5.4-mini',
      instructions: systemPrompt,
      input: [{ role: 'user', content: userPrompt }],
      text: {
        format: {
          type: 'json_schema',
          name: 'submittal_fit',
          schema: FIT_RESULT_SCHEMA,
          strict: true,
        },
      },
    })

    const output = JSON.parse(response.output_text)
    return { output }
  }
}
