/**
 * 运行时配置读取：把 Loader 交来的字段归一化为判定所需选项。
 *
 * `.volatile()` 字段在配置中表现为带 `get()` 的引用；每次判定都取引用内
 * 的当前值，因此设置页保存后无需重载插件即可生效。
 */

import { defaultBlockedDirs, expandPath } from './paths.js'

/** 插件运行模式。 */
export const MODE_DENY = 'deny'
export const MODE_WARN = 'warn'

/** bash 分析档位。 */
export const BASH_SCAN_OFF = 'off'
export const BASH_SCAN_STANDARD = 'standard'
export const BASH_SCAN_STRICT = 'strict'

/**
 * 读取一个配置字段的当前值。
 * @param {unknown} value - 可能是 `.volatile()` 引用，也可能是普通值。
 * @returns {unknown} 引用内的当前值，或原值。
 */
export function readVolatile(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

/**
 * 把配置中的路径列表归一化为绝对路径列表，丢弃空项。
 * @param {unknown} value - 配置值。
 * @param {string} [cwd] - 相对路径基准。
 * @returns {string[]} 绝对路径列表。
 */
function pathList(value, cwd) {
  const items = Array.isArray(value) ? value : []
  const result = []
  for (const item of items) {
    const resolved = expandPath(item, cwd)
    if (resolved && !result.includes(resolved)) result.push(resolved)
  }
  return result
}

/**
 * 归一化配置；非法或缺失字段回退到默认值。
 * @param {object|undefined} config - schemastery 校验后的配置。
 * @returns {{
 *   enabled: boolean,
 *   mode: string,
 *   readWarn: boolean,
 *   blockedDirs: string[],
 *   allowedPaths: string[],
 *   allowPlatformTemp: boolean,
 *   suggestDir: string,
 *   auditPath: string,
 *   bashScan: string,
 *   scanUnknownTools: boolean,
 *   denyLog: boolean,
 *   denyHint: string,
 * }} 归一化后的选项。
 */
export function resolveOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const read = key => readVolatile(source[key])

  const blockedDirs = pathList(read('blockedDirs'))
  if (blockedDirs.length === 0) blockedDirs.push(...defaultBlockedDirs())

  const mode = read('mode') === MODE_WARN ? MODE_WARN : MODE_DENY
  const bashScanValue = read('bashScan')
  const bashScan = bashScanValue === BASH_SCAN_OFF || bashScanValue === BASH_SCAN_STRICT
    ? bashScanValue
    : BASH_SCAN_STANDARD

  const suggestRaw = read('suggestDir')
  const suggestDir = typeof suggestRaw === 'string' ? suggestRaw.trim() : ''

  const auditPathRaw = read('auditPath')
  const auditPath = typeof auditPathRaw === 'string' ? auditPathRaw.trim() : ''

  const denyHintRaw = read('denyHint')
  return {
    enabled: read('enabled') !== false,
    mode,
    readWarn: read('readWarn') === true,
    blockedDirs,
    allowedPaths: pathList(read('allowedPaths')),
    allowPlatformTemp: read('allowPlatformTemp') === true,
    suggestDir,
    auditPath,
    bashScan,
    scanUnknownTools: read('scanUnknownTools') === true,
    denyLog: read('denyLog') === true,
    denyHint: typeof denyHintRaw === 'string' ? denyHintRaw.trim() : '',
  }
}