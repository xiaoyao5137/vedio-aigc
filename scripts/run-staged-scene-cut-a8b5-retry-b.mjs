#!/usr/bin/env node
// Variant-specific adapter; imported runner deeply verifies before its POST.
import { assertRetryVariantArgs } from './assert-staged-a8b5-retry-variant.mjs'

assertRetryVariantArgs(process.argv.slice(2))
await import('./run-staged-scene-cut-a8b5-phase-b.mjs')
