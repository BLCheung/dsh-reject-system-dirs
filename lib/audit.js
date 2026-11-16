/**
 * 审计记录写入。
 *
 * 只在用户开启读取告警或拒绝留痕时写入配置的目录；写入失败不影响工具调用的判定结果。
 * 目标路径是否安全由调用方判定。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 审计文件名。 */
export const AUDIT_FILE_NAME = 'reject-system-dirs.log'

/**
 * 追加一条 JSONL 记录。
 * @param {object} input - 记录参数。
 * @param {string|undefined} input.filePath - 日志文件绝对路径；缺失时不写。
 * @param {object} input.entry - 记录内容。
 * @param {(message: string) => void} [input.warn] - 写入失败时的告警回调。
 * @returns {Promise<void>} 写入结束。
 */
export async function appendAudit({ filePath, entry, warn }) {
  if (typeof filePath !== 'string' || filePath === '') return
  try {
    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (error) {
    if (typeof warn === 'function') {
      warn(`audit write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}