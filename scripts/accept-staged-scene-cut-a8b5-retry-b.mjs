#!/usr/bin/env node
// Reuse B acceptance; imported action deeply verifies before signing.
import { assertRetryVariantArgs } from './assert-staged-a8b5-retry-variant.mjs'

assertRetryVariantArgs(process.argv.slice(2))
await import('./accept-staged-scene-cut-a8b5-phase-b.mjs')
