import test from 'node:test'
import assert from 'node:assert/strict'

import { assetDownloadUrl } from '../src/asset-download.ts'

test('workflow attachment downloads keep inline and same-origin sources intact', () => {
  assert.equal(assetDownloadUrl('data:application/octet-stream;base64,AA==', '附件.xlsx'), 'data:application/octet-stream;base64,AA==')
  assert.equal(assetDownloadUrl('/data/附件.xlsx', '附件.xlsx'), '/data/附件.xlsx')
})

test('workflow attachment downloads proxy remote sources with the original filename', () => {
  assert.equal(
    assetDownloadUrl('https://example.com/files/source.xlsx?token=secret', '三国历史短剧1000集策划总表.xlsx'),
    '/api/media-download?url=https%3A%2F%2Fexample.com%2Ffiles%2Fsource.xlsx%3Ftoken%3Dsecret&filename=%E4%B8%89%E5%9B%BD%E5%8E%86%E5%8F%B2%E7%9F%AD%E5%89%A71000%E9%9B%86%E7%AD%96%E5%88%92%E6%80%BB%E8%A1%A8.xlsx',
  )
})
