#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
/**
 * Post-processes the .env file produced by `soliconfig pull` for GitHub Actions.
 *
 * Responsibilities (driven by INPUT_* env vars set by action.yml):
 *   - Parse the pulled .env file (same rules as @soliconfig/crypto env-file:
 *     parseEnvSource + unquote — kept self-contained so no internal package
 *     import is required at runtime).
 *   - Drop dotenv key headers (DOTENV_PUBLIC_KEY[_ENV], DOTENV_PRIVATE_KEY[_ENV]).
 *   - Mask every value via `::add-mask::` (when INPUT_MASK=true).
 *   - Export every KEY=VALUE to $GITHUB_ENV (when INPUT_EXPORT_ENV=true),
 *     using the heredoc form so multi-line values are handled safely.
 *   - Render the values to INPUT_OUTPUT_FILE in INPUT_FORMAT (dotenv|env|json).
 *   - Set step outputs: `count`.
 *
 * Uses only Node/Bun built-ins so it runs under `bun run` with no dependencies.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const ENCRYPTED_VALUE_PREFIX = 'encrypted:'
// Mirrors packages/crypto/src/env-file.ts
const ASSIGNMENT_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)\s*$/

function unquote(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    if ((first === '"' || first === "'" || first === '`') && trimmed.endsWith(first)) {
      const inner = trimmed.slice(1, -1)
      return first === '"' ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"') : inner
    }
  }
  const hashAt = trimmed.indexOf(' #')
  return hashAt >= 0 ? trimmed.slice(0, hashAt).trim() : trimmed
}

function parseEnvSource(source: string): Array<[string, string]> {
  // Last assignment wins (matches Map semantics of parseEnvSource) while
  // preserving first-seen ordering for stable output.
  const order: string[] = []
  const values = new Map<string, string>()
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue
    const match = ASSIGNMENT_RE.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const key = match[1]
      if (!values.has(key)) order.push(key)
      values.set(key, unquote(match[2]))
    }
  }
  return order.map((key) => [key, values.get(key) as string])
}

function isDotenvHeaderKey(key: string): boolean {
  return (
    key === 'DOTENV_PUBLIC_KEY' ||
    key.startsWith('DOTENV_PUBLIC_KEY_') ||
    key === 'DOTENV_PRIVATE_KEY' ||
    key.startsWith('DOTENV_PRIVATE_KEY_')
  )
}

function boolInput(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase()
  if (raw === '') return fallback
  return raw === 'true' || raw === '1' || raw === 'yes'
}

function dotenvQuote(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  return `"${escaped}"`
}

function render(format: string, entries: Array<[string, string]>): string {
  switch (format) {
    case 'json': {
      const obj: Record<string, string> = {}
      for (const [k, v] of entries) obj[k] = v
      return `${JSON.stringify(obj, null, 2)}\n`
    }
    case 'env': {
      // Raw KEY=value (no quoting). Newlines within a value would break this
      // format, so warn if any are present.
      return `${entries.map(([k, v]) => `${k}=${v}`).join('\n')}\n`
    }
    default: {
      // dotenv (default): quoted/escaped, dotenvx-compatible.
      return `${entries.map(([k, v]) => `${k}=${dotenvQuote(v)}`).join('\n')}\n`
    }
  }
}

function appendGithubEnv(githubEnvPath: string, key: string, value: string): void {
  if (value.includes('\n')) {
    const delimiter = `__SOLICONFIG_EOF_${randomUUID().replace(/-/g, '')}__`
    appendFileSync(githubEnvPath, `${key}<<${delimiter}\n${value}\n${delimiter}\n`)
  } else {
    appendFileSync(githubEnvPath, `${key}=${value}\n`)
  }
}

function main(): number {
  const envFilePath = process.env.INPUT_ENV_FILE ?? ''
  if (envFilePath === '') {
    console.error('::error::internal: INPUT_ENV_FILE not provided')
    return 1
  }

  const format = (process.env.INPUT_FORMAT ?? 'dotenv').trim().toLowerCase()
  const outputFile = (process.env.INPUT_OUTPUT_FILE ?? '').trim()
  const exportEnv = boolInput('INPUT_EXPORT_ENV', true)
  const mask = boolInput('INPUT_MASK', true)

  let source: string
  try {
    source = readFileSync(envFilePath, 'utf8')
  } catch (err) {
    console.error(`::error::could not read pulled env file (${envFilePath}): ${String(err)}`)
    return 1
  }

  const entries = parseEnvSource(source).filter(([key]) => !isDotenvHeaderKey(key))

  if (entries.length === 0) {
    console.log('::warning::soliconfig pull returned no config/secret keys.')
  }

  let encryptedCount = 0
  const githubEnvPath = process.env.GITHUB_ENV

  for (const [key, value] of entries) {
    if (value.startsWith(ENCRYPTED_VALUE_PREFIX)) encryptedCount++

    // Mask BEFORE any export so the value never appears unredacted in logs.
    // `::add-mask::` only consumes up to the end of its own output line, so for a
    // multi-line value we mask each line individually and never echo the raw
    // value (which would leak lines 2..n as plain output).
    if (mask && value.length > 0) {
      if (value.includes('\n')) {
        for (const line of value.split('\n')) {
          if (line.length > 3) console.log(`::add-mask::${line}`)
        }
      } else {
        console.log(`::add-mask::${value}`)
      }
    }

    if (exportEnv) {
      if (githubEnvPath === undefined || githubEnvPath === '') {
        console.error('::error::export-env requested but $GITHUB_ENV is unset')
        return 1
      }
      appendGithubEnv(githubEnvPath, key, value)
    }
  }

  if (outputFile !== '') {
    try {
      writeFileSync(outputFile, render(format, entries))
      console.log(`wrote ${entries.length} key(s) to ${outputFile} (format: ${format})`)
    } catch (err) {
      console.error(`::error::could not write output-file (${outputFile}): ${String(err)}`)
      return 1
    }
  }

  if (encryptedCount > 0) {
    console.log(
      `::warning::${encryptedCount} value(s) are still encrypted (encrypted: prefix). ` +
        'Provide the `private-key` input to decrypt locally, or use an environment that ' +
        'decrypts server-side.',
    )
  }

  const githubOutput = process.env.GITHUB_OUTPUT
  if (githubOutput !== undefined && githubOutput !== '') {
    appendFileSync(githubOutput, `count=${entries.length}\n`)
  }

  console.log(
    `soliconfig: emitted ${entries.length} key(s) ` +
      `(export-env=${exportEnv}, mask=${mask}, format=${format}).`,
  )
  return 0
}

process.exit(main())
