import { Script, createContext } from 'node:vm'
import readExcelFile from 'read-excel-file/node'

export type CodeNodeUpload = {
  id?: string
  name: string
  dataUrl: string
  mimeType?: string
  size?: number
}

export type CodeNodeRequest = {
  code: string
  prompt?: string
  params?: Record<string, unknown>
  context?: Record<string, unknown>
  files?: CodeNodeUpload[]
}

type ExcelCell = string | number | boolean | Date | null
type ExcelRow = ExcelCell[]
type ExcelSheet = { sheet: string; data: ExcelRow[] }
type PreparedWorkbook = {
  id: string
  name: string
  mimeType: string
  size: number
  sheets: Array<{ name: string; data: Array<Array<string | number | boolean | null>> }>
}

const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_ROWS = 20_000
const MAX_COLUMNS = 500
const MAX_FILES = 5
const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024
const MAX_RESULT_BYTES = 4 * 1024 * 1024
const EXECUTION_TIMEOUT_MS = 1_500
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])
const reservedBindings = new Set(['context', 'params', 'files', 'excel', 'prompt', 'console', 'globalThis'])

function decodeWorkbook(upload: CodeNodeUpload) {
  if (!/\.xlsx$/i.test(upload.name)) throw new Error(`仅支持 .xlsx 文件：${upload.name}`)
  const match = upload.dataUrl.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/)
  if (!match) throw new Error(`Excel 文件 ${upload.name} 尚未上传完成`)
  const bytes = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8')
  if (!bytes.length) throw new Error(`Excel 文件 ${upload.name} 内容为空`)
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`Excel 文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024}MB`)
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`${upload.name} 不是有效的 .xlsx 文件`)
  return bytes
}

function normalizedCell(value: ExcelCell): string | number | boolean | null {
  if (value instanceof Date) return value.toISOString()
  if (value === undefined) return null
  return value
}

function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error('代码节点输入嵌套层级过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, depth + 1))
  if (typeof value === 'object') {
    const output: Record<string, unknown> = Object.create(null)
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!unsafeKeys.has(key)) output[key] = sanitizeJson(item, depth + 1)
    }
    return output
  }
  return null
}

async function prepareWorkbook(upload: CodeNodeUpload, index: number): Promise<PreparedWorkbook> {
  const workbookBytes = decodeWorkbook(upload)
  const sheets = await readExcelFile(workbookBytes) as ExcelSheet[]
  for (const sheet of sheets) {
    if (sheet.data.length > MAX_ROWS) throw new Error(`工作表“${sheet.sheet}”超过 ${MAX_ROWS} 行限制`)
    if (sheet.data.some((row) => row.length > MAX_COLUMNS)) throw new Error(`工作表“${sheet.sheet}”超过 ${MAX_COLUMNS} 列限制`)
  }
  return {
    id: upload.id || `file-${index + 1}`,
    name: upload.name,
    mimeType: upload.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: workbookBytes.length,
    sheets: sheets.map((sheet) => ({
      name: sheet.sheet,
      data: sheet.data.map((row) => row.map(normalizedCell)),
    })),
  }
}

function safeBindingNames(context: Record<string, unknown>) {
  return Object.keys(context).filter((key) => /^[A-Za-z_$][\w$]*$/.test(key) && !unsafeKeys.has(key) && !reservedBindings.has(key))
}

function jsonText(value: unknown, label: string, maxBytes = MAX_PAYLOAD_BYTES) {
  let serialized: string
  try {
    serialized = JSON.stringify(sanitizeJson(value))
  } catch (error) {
    throw new Error(`${label}无法序列化：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error(`${label}超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`)
  return serialized
}

function resolvePlaceholderPath(source: Record<string, unknown>, path: string) {
  let value: unknown = source
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !(key in value)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

export function interpolateCodePlaceholders(code: string, context: Record<string, unknown>) {
  return code.replace(/\$\{([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\}/g, (_placeholder, path: string) => {
    const serialized = JSON.stringify(sanitizeJson(resolvePlaceholderPath(context, path)))
    return serialized === undefined ? 'undefined' : serialized
  })
}

const EXCEL_RUNTIME = String.raw`
const __unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const __isEmptyRow = (row) => row.every((value) => value === null || value === undefined || String(value).trim() === '');
const __headerName = (value, index, seen) => {
  const original = String(value ?? '').trim() || 'column_' + (index + 1);
  const safe = __unsafeKeys.has(original) ? 'column_' + original : original;
  const count = (seen.get(safe) || 0) + 1;
  seen.set(safe, count);
  return count === 1 ? safe : safe + '_' + count;
};
const __positiveInteger = (value, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};
const __resolveWorkbook = (file) => {
  if (file === undefined || file === null) {
    if (__workbooks.length !== 1) throw new Error('excel.parse 未指定文件，且当前节点不是恰好一个附件');
    return __workbooks[0];
  }
  if (typeof file === 'number') return __workbooks[file];
  const id = typeof file === 'string' ? file : file.id;
  const name = typeof file === 'object' && file ? file.name : file;
  return __workbooks.find((item) => item.id === id || item.name === name);
};
const excel = Object.freeze({
  parse(file, options = {}) {
    const workbook = __resolveWorkbook(file);
    if (!workbook) throw new Error('excel.parse 找不到指定的 Excel 附件');
    const requestedSheet = String(options.sheetName ?? '').trim();
    const sheet = requestedSheet
      ? workbook.sheets.find((item) => item.name === requestedSheet)
      : workbook.sheets[0];
    if (!sheet) {
      const names = workbook.sheets.map((item) => item.name).join('、');
      throw new Error('未找到工作表“' + requestedSheet + '”，可用工作表：' + names);
    }
    const headerRow = __positiveInteger(options.headerRow, 1);
    const headerValues = sheet.data[headerRow - 1];
    if (!headerValues) throw new Error('工作表“' + sheet.name + '”不存在第 ' + headerRow + ' 行表头');
    const seen = new Map();
    const headers = headerValues.map((value, index) => __headerName(value, index, seen));
    const allRows = [];
    const rowNumbers = [];
    sheet.data.slice(headerRow).forEach((row, index) => {
      if (__isEmptyRow(row)) return;
      const record = Object.create(null);
      headers.forEach((header, column) => { record[header] = row[column] ?? null; });
      allRows.push(record);
      rowNumbers.push(headerRow + index + 1);
    });
    const outputLimit = Math.min(__positiveInteger(options.outputLimit, 500), 5000);
    return {
      workbook: {
        fileName: workbook.name,
        size: workbook.size,
        sheetNames: workbook.sheets.map((item) => item.name),
      },
      sheet: {
        name: sheet.name,
        headerRow,
        headers,
        rowCount: allRows.length,
        columnCount: headers.length,
      },
      rows: allRows.slice(0, outputLimit),
      rowNumbers: rowNumbers.slice(0, outputLimit),
      count: allRows.length,
      truncated: allRows.length > outputLimit,
    };
  },
});`

function buildScript(code: string, aliases: string[]) {
  const aliasDeclarations = aliases.map((key) => `const ${key} = context[${JSON.stringify(key)}];`).join('\n')
  return `
(() => {
  "use strict";
  const __logs = [];
  const __formatLogValue = (value) => {
    if (typeof value === 'string') return value;
    try {
      const serialized = JSON.stringify(value);
      return serialized === undefined ? String(value) : serialized;
    } catch {
      return String(value);
    }
  };
  const __appendLog = (level, values) => {
    if (__logs.length >= 100) return;
    __logs.push(('[' + level + '] ' + values.map(__formatLogValue).join(' ')).slice(0, 2000));
  };
  const console = Object.freeze({
    log: (...values) => __appendLog('log', values),
    info: (...values) => __appendLog('info', values),
    warn: (...values) => __appendLog('warn', values),
    error: (...values) => __appendLog('error', values),
  });
  const context = JSON.parse(__contextJson);
  const params = JSON.parse(__paramsJson);
  const prompt = JSON.parse(__promptJson);
  const __workbooks = JSON.parse(__workbooksJson);
  const files = __workbooks.map(({ id, name, mimeType, size }, index) => ({ id, name, mimeType, size, index }));
  ${EXCEL_RUNTIME}
  ${aliasDeclarations}
  const __result = (() => {
    "use strict";
${code}
  })();
  if (__result && typeof __result.then === 'function') {
    throw new Error('代码节点暂不支持异步 Promise；excel.parse 是同步 API，请直接调用并返回结果');
  }
  return { result: __result, logs: __logs };
})()
`
}

function serializeResult(value: unknown) {
  if (value && typeof (value as { then?: unknown }).then === 'function') {
    throw new Error('代码节点暂不支持异步 Promise；excel.parse 是同步 API，请直接调用并返回结果')
  }
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new Error(`代码执行结果必须是可序列化数据：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (serialized === undefined) throw new Error('代码执行没有返回结果，请使用 return 返回可序列化对象')
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) throw new Error('代码执行结果超过 4MB 限制')
  return JSON.parse(serialized) as unknown
}

export async function executeCodeNode(request: CodeNodeRequest) {
  const code = String(request.code ?? '').trim()
  if (!code) throw new Error('请先配置代码执行节点的 JavaScript 代码')
  const uploads = request.files ?? []
  if (uploads.length > MAX_FILES) throw new Error(`代码节点最多上传 ${MAX_FILES} 个 Excel 文件`)
  const prepared = await Promise.all(uploads.map(prepareWorkbook))
  const workbooksJson = jsonText(prepared, 'Excel 解析数据')
  const contextValue = sanitizeJson(request.context ?? {}) as Record<string, unknown>
  const sandbox = {
    __contextJson: jsonText(contextValue, '流程上下文'),
    __paramsJson: jsonText(request.params ?? {}, '节点参数'),
    __promptJson: jsonText(request.prompt ?? '', '节点说明'),
    __workbooksJson: workbooksJson,
  }
  const vmContext = createContext(sandbox, {
    name: 'workflow-code-node',
    codeGeneration: { strings: false, wasm: false },
  })
  let rawResult: unknown
  try {
    const resolvedCode = interpolateCodePlaceholders(code, contextValue)
    const script = new Script(buildScript(resolvedCode, safeBindingNames(contextValue)), {
      filename: 'workflow-code-node.js',
    })
    rawResult = script.runInContext(vmContext, { timeout: EXECUTION_TIMEOUT_MS, displayErrors: true })
  } catch (error) {
    throw new Error(`代码执行失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const envelope = serializeResult(rawResult) as { result: unknown; logs?: unknown }
  const result = envelope.result
  const logs = Array.isArray(envelope.logs) ? envelope.logs.map(String).slice(0, 100) : []
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), executionLogs: logs }
  }
  return { value: result, executionLogs: logs }
}
