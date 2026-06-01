import pino from 'pino'

const logLevel = (typeof Deno !== 'undefined' ? Deno.env.get('LOG_LEVEL') : undefined) ?? 'info'

const baseLogger = pino({
  level: logLevel,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
})

const mirrorToConsole =
  typeof Deno !== 'undefined' &&
  (Deno.env.get('LOG_MIRROR_TO_CONSOLE') ?? 'true').toLowerCase() === 'true'

type LogArgs = unknown[]

export type LoggerLike = {
  trace: (...args: LogArgs) => void
  debug: (...args: LogArgs) => void
  info: (...args: LogArgs) => void
  warn: (...args: LogArgs) => void
  error: (...args: LogArgs) => void
  fatal: (...args: LogArgs) => void
  child: (bindings: Record<string, unknown>) => LoggerLike
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.replaceAll('\n', '\\n'),
    }
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeValue(v)]),
    )
  }
  return value
}

function toSingleLine(
  level: string,
  args: LogArgs,
  bindings: Record<string, unknown> = {},
): string {
  const first = args[0]
  const second = args[1]
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    return JSON.stringify({
      level,
      ...bindings,
      ...(normalizeValue(first) as Record<string, unknown>),
      ...(typeof second === 'string' ? { msg: second } : {}),
    })
  }
  if (typeof first === 'string') return JSON.stringify({ level, ...bindings, msg: first })
  return JSON.stringify({ level, ...bindings, args: normalizeValue(args) })
}

function consoleMethodForLevel(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal') {
  if (level === 'trace' || level === 'debug') return console.debug
  if (level === 'info') return console.info
  if (level === 'warn') return console.warn
  return console.error
}

function wrapLogger(
  current: pino.Logger,
  cumulativeBindings: Record<string, unknown> = {},
): LoggerLike {
  const emit = (
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    args: LogArgs,
  ) => {
    current[level](...(args as Parameters<pino.Logger[typeof level]>))
    if (!mirrorToConsole) return
    consoleMethodForLevel(level)(toSingleLine(level, args, cumulativeBindings))
  }

  return {
    trace: (...args: LogArgs) => emit('trace', args),
    debug: (...args: LogArgs) => emit('debug', args),
    info: (...args: LogArgs) => emit('info', args),
    warn: (...args: LogArgs) => emit('warn', args),
    error: (...args: LogArgs) => emit('error', args),
    fatal: (...args: LogArgs) => emit('fatal', args),
    child: (bindings: Record<string, unknown>) =>
      wrapLogger(current.child(bindings), { ...cumulativeBindings, ...bindings }),
  }
}

export const logger = wrapLogger(baseLogger)
