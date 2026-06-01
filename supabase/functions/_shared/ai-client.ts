import OpenAI from 'openai'
import type { LoggerLike } from './logger.ts'

type JsonSchemaValue =
  | string
  | number
  | boolean
  | null
  | JsonSchemaValue[]
  | { [k: string]: JsonSchemaValue }

export type JsonSchema = { [k: string]: JsonSchemaValue }

export type TokenUsage = {
  input: number
  output: number
  model?: string
  latencyMs: number
}

export interface AiClient {
  completeJson<T>(
    system: string,
    userPrompt: string,
    schemaName: string,
    schema: JsonSchema,
  ): Promise<{ data: T; tokens: TokenUsage }>
}

export class OpenAiResponsesClient implements AiClient {
  private client: OpenAI
  private model: string
  readonly log: LoggerLike

  constructor(model: string, log: LoggerLike) {
    this.model = model
    this.log = log
    this.client = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY') })
  }

  async completeJson<T>(
    system: string,
    userPrompt: string,
    schemaName: string,
    schema: JsonSchema,
  ): Promise<{ data: T; tokens: TokenUsage }> {
    this.log.debug({ model: this.model, schemaName }, 'ai-client: sending Responses API request')

    const start = performance.now()
    // deno-lint-ignore no-explicit-any
    const response = await (this.client as any).responses.create({
      model: this.model,
      instructions: system,
      input: [{ role: 'user', content: userPrompt }],
      text: {
        format: {
          type: 'json_schema',
          name: schemaName,
          schema,
          strict: true,
        },
      },
    })

    // deno-lint-ignore no-explicit-any
    const content: string = (response as any).output_text ?? ''
    if (!content) {
      throw new Error(`${this.model}: empty response from OpenAI Responses API`)
    }

    let data: T
    try {
      data = JSON.parse(content) as T
    } catch {
      throw new Error(`${this.model}: failed to parse JSON from OpenAI response`)
    }

    const latencyMs = Math.round(performance.now() - start)
    // deno-lint-ignore no-explicit-any
    const u = (response as any).usage
    const tokens: TokenUsage = {
      input: (u?.input_tokens as number | undefined) ?? 0,
      output: (u?.output_tokens as number | undefined) ?? 0,
      model: this.model,
      latencyMs,
    }

    this.log.debug(
      { model: this.model, inputTokens: tokens.input, outputTokens: tokens.output, latencyMs },
      'ai-client: response received',
    )
    return { data, tokens }
  }
}
