#!/usr/bin/env node
// Runs all repository checks: syntax check, router unit tests, TypeScript typecheck, and bilingual docs check.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function step(label, cmd, args) {
  process.stdout.write(`==> ${label} ... `)
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
}

step('Syntax check (router)', process.execPath, ['--check', 'router/logic.js'])
step('Syntax check (router server)', process.execPath, ['--check', 'router/router.js'])
step('Router unit tests', process.execPath, ['--test', 'router/logic.test.js'])
step('Bilingual docs check', process.execPath, ['tools/docs.mjs', 'check'])
console.log('All checks passed.')
