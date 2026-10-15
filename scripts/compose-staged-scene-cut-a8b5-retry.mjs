#!/usr/bin/env node
// Reuse 313-frame composition; imported action deeply verifies before writes.
import { assertRetryVariantArgs } from './assert-staged-a8b5-retry-variant.mjs'

assertRetryVariantArgs(process.argv.slice(2))
await import('./compose-staged-scene-cut-a8b5.mjs')
