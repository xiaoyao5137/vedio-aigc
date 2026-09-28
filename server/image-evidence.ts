import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { isPublicInternetUrl } from './web-sources.ts'
type Value = Record<string, unknown>
/** Decode media into model-readable attachments without an embedded judgement. */
export async function collectImageEvidence(options: { items: Value[] }, root = process.cwd()) {
  if (!Array.isArray(options.items) || !options.items.length || options.items.length > 7) throw new Error('IMAGE_EVIDENCE_INVALID: 需要 1–7 张图片')
  const dir = path.join(root, 'public/generated'); await mkdir(dir, {recursive:true})
  const items: Value[]=[]
  for(const item of options.items) {
    const url=String(item.url ?? item.uri ?? '')
    let bytes:Buffer
    if(/^\/generated\/[\w.-]+\.(png|jpe?g|webp)$/i.test(url)) bytes=await readFile(path.join(root,'public',url))
    else {
      if(!isPublicInternetUrl(url)) throw new Error('IMAGE_EVIDENCE_INVALID: 图片地址无效')
      const response=await fetch(url,{signal:AbortSignal.timeout(120_000)})
      if(!response.ok) throw new Error(`图片下载 HTTP ${response.status}`)
      const chunks:Uint8Array[]=[];let size=0
      if(!response.body)throw new Error('图片内容为空')
      for await(const chunk of response.body){size+=chunk.length;if(size>20*1024*1024)throw new Error('图片超过20MB');chunks.push(chunk)}
      bytes=Buffer.concat(chunks)
    }
    const metadata=await sharp(bytes).metadata()
    const key=createHash('sha256').update(bytes).digest('hex').slice(0,24)
    const referenceImage=`/generated/image-evidence-${key}.jpg`
    await sharp(bytes).resize({width:1600,height:1200,fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toFile(path.join(root,'public',referenceImage))
    items.push({...item,referenceImage,measurement:{width:metadata.width,height:metadata.height,format:metadata.format,bytes:bytes.length},decoded:true})
  }
  const key=createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0,24)
  const report={items,reviewImages:items.map(i=>i.referenceImage),evidenceUrl:`/generated/image-evidence-${key}.json`}
  await writeFile(path.join(root,'public',report.evidenceUrl),JSON.stringify(report,null,2))
  return report
}
