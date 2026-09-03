// @vitest-environment node
//
// Node rather than the suite-wide jsdom: this file imports Vite's parser, and
// jsdom's TextEncoder does not satisfy the invariant esbuild asserts on load.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// Rollup's parser, re-exported by Vite (already a devDependency). Used instead
// of a raw regex so both checks below see identifiers only — never a name that
// happens to appear inside a comment or a string literal.
import { parseAst } from 'vite'

// The boundary guard for apps/adjuster/src/core/ (spec 021, BH-121).
//
// Two checks, because the first alone is not sufficient.
//
// 1. No Apps Script global may be named by a core file. Catches the direct leak.
// 2. No core file may reference a cross-file symbol that is not defined under
//    core/ or on the short allowlist below. Catches the indirect leak the first
//    check waves through: a core file calling logEvent(), which calls
//    appendRaw(), which reaches SpreadsheetApp through jobs.js. The lexical
//    check sees nothing wrong with that; this one fails on `logEvent`.
//
// Both checks are deliberately in place before any file moved into core/, so
// nothing can leak in while the move is in flight.

const CORE_DIR = 'apps/adjuster/src/core'

const APPS_SCRIPT_GLOBALS = [
  'DriveApp',
  'DocumentApp',
  'SpreadsheetApp',
  'PropertiesService',
  'UrlFetchApp',
  'LockService',
  'CacheService',
  'CalendarApp',
  'ScriptApp',
  'MailApp',
  'GmailApp',
  'HtmlService',
  'Utilities',
  'Session',
]

// Plain-JavaScript names every runtime provides. Not a policy decision — these
// exist in Apps Script, in Node, and in a browser alike.
const LANGUAGE_GLOBALS = new Set([
  'Array',
  'Boolean',
  'Date',
  'Error',
  'Function',
  'Infinity',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'RangeError',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'arguments',
  'decodeURIComponent',
  'encodeURIComponent',
  'globalThis',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'undefined',
])

// The declared allowlist. Everything a core file uses should arrive as an
// argument (config, tagSchema, glossary) or through deps (fetch, logger,
// sleep, base64Encode, stringToBytes) — so this list staying at one entry is
// the point of it existing. Adding to it is a reviewable act: each entry is a
// symbol core may reach for without it being passed in.
const ALLOWLIST = new Set([
  // Present in every runtime this core targets, and seeded into the bare vm
  // context loadGs() builds. Core still logs through deps.logger; this is here
  // because a stray console.error in a catch block is not a portability bug.
  'console',
])

type Node = Record<string, any>

function coreFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) return walk(full)
      return full.endsWith('.js') ? [full] : []
    })

  return walk(path.resolve(process.cwd(), CORE_DIR)).sort()
}

function parse(file: string): Node {
  return parseAst(readFileSync(file, 'utf-8')) as unknown as Node
}

/** Every child node of `node`, whatever the node type. */
function children(node: Node): Node[] {
  const out: Node[] = []
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue
    const value = node[key]
    if (Array.isArray(value)) {
      value.forEach((item) => item && typeof item === 'object' && item.type && out.push(item))
    } else if (value && typeof value === 'object' && value.type) {
      out.push(value)
    }
  }
  return out
}

function isFunction(node: Node): boolean {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  )
}

/** Every identifier name appearing anywhere in the file, comments and strings excluded. */
function identifierNames(node: Node, out: Set<string> = new Set()): Set<string> {
  if (node.type === 'Identifier') out.add(node.name)
  children(node).forEach((child) => identifierNames(child, out))
  return out
}

/**
 * `var` and function declarations reachable from `node` without crossing into a
 * nested function — which is exactly what hoists into the scope `node` opens.
 */
function hoistedNames(node: Node, out: Set<string>, skipSelf = true): Set<string> {
  if (!skipSelf && isFunction(node)) {
    if (node.id) out.add(node.id.name)
    return out
  }

  if (node.type === 'VariableDeclarator') {
    patternNames(node.id, out)
  } else if (node.type === 'FunctionDeclaration') {
    if (node.id) out.add(node.id.name)
    return out
  }

  children(node).forEach((child) => hoistedNames(child, out, false))
  return out
}

function patternNames(node: Node, out: Set<string>): void {
  if (!node) return
  if (node.type === 'Identifier') out.add(node.name)
  else children(node).forEach((child) => patternNames(child, out))
}

function functionScope(node: Node): Set<string> {
  const scope = new Set<string>()
  ;(node.params || []).forEach((param: Node) => patternNames(param, scope))
  if (node.type === 'FunctionExpression' && node.id) scope.add(node.id.name)
  if (node.body) hoistedNames(node.body, scope)
  return scope
}

/**
 * Walks references with a scope chain, so a local variable never reads as a
 * free identifier and a genuinely undeclared one always does.
 */
function collectFreeIdentifiers(node: Node, scopes: Set<string>[], out: Set<string>): void {
  const resolves = (name: string) => scopes.some((scope) => scope.has(name))
  const descend = (child: Node) => collectFreeIdentifiers(child, scopes, out)

  switch (node.type) {
    case 'Identifier':
      if (!resolves(node.name)) out.add(node.name)
      return

    case 'MemberExpression':
      descend(node.object)
      if (node.computed) descend(node.property)
      return

    case 'Property':
      if (node.computed) descend(node.key)
      descend(node.value)
      return

    case 'VariableDeclarator':
      if (node.init) descend(node.init)
      return

    case 'LabeledStatement':
      descend(node.body)
      return

    case 'BreakStatement':
    case 'ContinueStatement':
      return

    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const inner = scopes.concat([functionScope(node)])
      ;(node.params || []).forEach((param: Node) => collectFreeIdentifiers(param, inner, out))
      if (node.body) collectFreeIdentifiers(node.body, inner, out)
      return
    }

    case 'CatchClause': {
      const caught = new Set<string>()
      if (node.param) patternNames(node.param, caught)
      collectFreeIdentifiers(node.body, scopes.concat([caught]), out)
      return
    }

    default:
      children(node).forEach(descend)
  }
}

describe('core/ boundary — Apps Script globals', () => {
  it('names no Apps Script global anywhere under core/', () => {
    const offenders: string[] = []

    coreFiles().forEach((file) => {
      const names = identifierNames(parse(file))
      APPS_SCRIPT_GLOBALS.filter((global) => names.has(global)).forEach((global) =>
        offenders.push(`${path.relative(process.cwd(), file)} references ${global}`),
      )
    })

    expect(offenders).toEqual([])
  })
})

describe('core/ boundary — free identifiers', () => {
  it('references no cross-file symbol outside core/ and the declared allowlist', () => {
    const files = coreFiles()
    const asts = files.map((file) => ({ file, ast: parse(file) }))

    // Apps Script concatenates every file into one global scope, so core's own
    // "module scope" is the union of the top-level declarations of every file
    // under core/ — a symbol one core file defines is legitimately visible to
    // the next.
    const coreScope = new Set<string>()
    asts.forEach(({ ast }) => hoistedNames(ast, coreScope))

    const offenders: string[] = []

    asts.forEach(({ file, ast }) => {
      const free = new Set<string>()
      collectFreeIdentifiers(ast, [coreScope], free)
      ;[...free]
        .filter((name) => !LANGUAGE_GLOBALS.has(name) && !ALLOWLIST.has(name))
        .sort()
        .forEach((name) =>
          offenders.push(`${path.relative(process.cwd(), file)} references ${name}`),
        )
    })

    expect(offenders).toEqual([])
  })

  it('resolves a symbol one core file defines and another core file calls', () => {
    // The check above is only meaningful if the core-wide scope really is
    // shared, which is the Apps Script semantics it is modelling. Asserted
    // directly so a regression to per-file scoping shows up as a failed
    // expectation rather than as a suite that passes for the wrong reason.
    const defined = parseAst('function coreHelper() { return 1 }') as unknown as Node
    const caller = parseAst('function coreEntry() { return coreHelper() }') as unknown as Node

    const scope = new Set<string>()
    hoistedNames(defined, scope)
    hoistedNames(caller, scope)

    const free = new Set<string>()
    collectFreeIdentifiers(caller, [scope], free)

    expect([...free]).toEqual([])
  })

  it('flags an adapter symbol a core file reaches for', () => {
    // The logEvent -> appendRaw -> SpreadsheetApp path, in miniature: nothing
    // here names an Apps Script global, and the check still fails.
    const leaky = parseAst('function coreEntry() { logEvent("x", {}) }') as unknown as Node

    const scope = new Set<string>()
    hoistedNames(leaky, scope)

    const free = new Set<string>()
    collectFreeIdentifiers(leaky, [scope], free)

    expect([...free]).toEqual(['logEvent'])
  })
})
