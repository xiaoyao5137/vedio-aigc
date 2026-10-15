#!/usr/bin/env node
// Reuse native review; imported action deeply verifies before evidence writes.
import { assertRetryVariantArgs } from './assert-staged-a8b5-retry-variant.mjs'

assertRetryVariantArgs(process.argv.slice(2))
await import('./review-staged-scene-cut-a8b5-phase-b.mjs')
