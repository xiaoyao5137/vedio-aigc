import type { Pool } from 'pg'

// 三国工作流的史料原文改为运行时联网抓取（见 server/web-sources.ts）。
// 这里只保留对存量表的只读统计，供“配置库诊断”展示；不再提供本地史料库的写入与检索实现。
export async function readKnowledgeStats(pool: Pool) {
  const result = await pool.query(`
    select
      (select count(*)::int from knowledge_documents) as documents,
      (select count(*)::int from knowledge_chunks) as chunks,
      (select count(*)::int from character_assets) as character_assets
  `)
  return result.rows[0] ?? { documents: 0, chunks: 0, character_assets: 0 }
}
