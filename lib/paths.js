/**
 * 系统目录清单、路径归一化与包含判断。
 *
 * 词法判断用于同步场景（bash 分析、词法兜底）；异步场景由调用方通过
 * `ctx.fs.resolve` / `ctx.fs.contains` 做等价判断。
 */

import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** macOS 的系统内置目录。 */
const DARWIN_BLOCKED = [
  '/tmp', '/var', '/etc', '/usr', '/bin', '/sbin',
  '/System', '/Library', '/Applications', '/opt', '/dev', '/cores',
]

/** Linux 的系统内置目录；`/home` 属于用户目录，不在此列。 */
const LINUX_BLOCKED = [
  '/tmp', '/var', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
  '/boot', '/dev', '/proc', '/sys', '/run', '/root', '/srv',
]

/** Windows 的基础系统目录；插件主要面向 macOS 与 Linux。 */
const WIN32_BLOCKED = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
]

/**
 * 返回当前平台的默认被禁目录。
 * @returns {string[]} 绝对路径列表。
 */
export function defaultBlockedDirs() {
  if (process.platform === 'darwin') return [...DARWIN_BLOCKED]
  if (process.platform === 'win32') return [...WIN32_BLOCKED]
  return [...LINUX_BLOCKED]
}

/**
 * 把用户输入展开为主机上的绝对路径：支持 `~` 与相对路径。
 * @param {unknown} input - 配置或命令中的路径。
 * @param {string} [cwd] - 相对路径的基准目录。
 * @returns {string|undefined} 归一化绝对路径；空值返回 undefined。
 */
export function expandPath(input, cwd) {
  if (typeof input !== 'string') return undefined
  let value = input.trim()
  if (value === '') return undefined
  if (value === '~') value = homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = join(homedir(), value.slice(2))
  if (!isAbsolute(value)) value = resolve(cwd ?? process.cwd(), value)
  return normalizePath(value)
}

/**
 * 去掉重复分隔符与结尾分隔符，保留根路径本身。
 * @param {string} value - 路径。
 * @returns {string} 归一化路径。
 */
export function normalizePath(value) {
  const absolute = resolve(value)
  if (absolute === sep) return absolute
  return absolute.replace(/[\\/]+$/, '')
}

/**
 * 尽力取真实路径；目标不存在或不可访问时回退为归一化路径。
 * @param {string} value - 路径。
 * @returns {string} 真实路径或归一化路径。
 */
export function realpathOrSelf(value) {
  try {
    return normalizePath(realpathSync(value))
  } catch {
    return normalizePath(value)
  }
}

/**
 * 去掉最后一段路径，不做 `..` 折叠。
 * @param {string} value - 绝对路径。
 * @returns {string} 父路径。
 */
function parentOf(value) {
  const trimmed = value.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index <= 0 ? sep : trimmed.slice(0, index)
}

/**
 * 解析真实路径：对不存在的目标，解析最近存在的祖先并拼回缺失后缀。
 * `..` 保留给真实路径解析，避免符号链接被字面折叠绕过。
 * @param {string} value - 路径。
 * @returns {string} 真实路径或归一化路径。
 */
export function realpathNearest(value) {
  if (typeof value !== 'string' || value === '') return normalizePath(value)
  const absolute = isAbsolute(value) ? value : resolve(value)
  if (/^[A-Za-z]:/.test(absolute)) return normalizePath(realpathOrSelf(absolute))
  const parts = absolute.split(/[\\/]+/).filter(Boolean)
  let resolved = sep
  let missing = false
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      resolved = parentOf(resolved)
      continue
    }
    const candidate = resolved === sep ? `${sep}${part}` : `${resolved}${sep}${part}`
    if (missing) {
      resolved = candidate
      continue
    }
    try {
      resolved = realpathSync(candidate)
    } catch {
      missing = true
      resolved = candidate
    }
  }
  return normalizePath(resolved)
}

/**
 * 判断会话项目根是否安全：不得是系统目录本身，也不得是被禁根的祖先；
 * 提供会话创建目录时，当前项目根还必须位于该目录之内。
 * @param {string|undefined} projectRoot - 项目根。
 * @param {string[]} [blockedDirs] - 被禁根。
 * @param {string} [anchor] - 会话创建时的目录。
 * @returns {boolean} 是否可以按项目根放行。
 */
export function isSafeProjectRoot(projectRoot, blockedDirs = [], anchor) {
  if (typeof projectRoot !== 'string' || projectRoot === '') return false
  const root = realpathNearest(projectRoot)
  if (root === sep) return false
  let anchorRoot
  if (anchor) {
    const candidate = realpathNearest(anchor)
    const unsafeAnchor = candidate === sep
      || blockedDirs.some(blocked => isPathUnder(realpathNearest(blocked), candidate))
    if (!unsafeAnchor) anchorRoot = candidate
  }
  if (anchorRoot) {
    if (!isPathUnder(root, anchorRoot)) return false
  } else {
    for (const blocked of blockedDirs) {
      if (isPathUnder(root, realpathNearest(blocked))) return false
    }
  }
  for (const blocked of blockedDirs) {
    const blockedRoot = realpathNearest(blocked)
    if (isPathUnder(blockedRoot, root)) return false
  }
  return true
}

/**
 * 当前平台是否使用大小写不敏感的文件系统。
 * @returns {boolean} darwin 与 win32 返回 true。
 */
export function isCaseInsensitivePlatform() {
  return process.platform === 'darwin' || process.platform === 'win32'
}

/**
 * 生成用于比较的路径键。
 * @param {string} value - 路径。
 * @returns {string} 大小写处理后的路径。
 */
export function pathKey(value) {
  const normalized = normalizePath(value)
  return isCaseInsensitivePlatform() ? normalized.toLowerCase() : normalized
}

/**
 * 判断 child 是否等于 parent 或位于 parent 之下（按路径分量比较）。
 * @param {string} child - 子路径。
 * @param {string} parent - 父路径。
 * @returns {boolean} 是否包含。
 */
export function isPathUnder(child, parent) {
  const childKey = pathKey(child)
  const parentKey = pathKey(parent)
  if (childKey === parentKey) return true
  return childKey.startsWith(parentKey.endsWith(sep) ? parentKey : `${parentKey}${sep}`)
}

/**
 * 判断是否为允许写入的设备节点。
 * @param {string} value - 路径。
 * @returns {boolean} 是否为安全设备。
 */
export function isDeviceException(value) {
  const path = normalizePath(value)
  if (path === '/dev/null' || path === '/dev/zero' || path === '/dev/stdin'
    || path === '/dev/stdout' || path === '/dev/stderr') return true
  return path.startsWith('/dev/fd/') || path.startsWith('/proc/self/fd/')
}

/**
 * 计算 target 相对 root 的路径。
 * @param {string} target - 目标路径。
 * @param {string} root - 根路径。
 * @returns {string} 相对路径。
 */
export function relativeUnder(target, root) {
  return relative(normalizePath(root), normalizePath(target))
}

/**
 * 解析镜像基址。
 * 空值或 `<项目>/.agents` 视为项目内 `.agents`；相对路径基于会话项目根；
 * 支持 `~` 与绝对路径。
 * @param {string|undefined} suggestDir - 配置值。
 * @param {string|undefined} projectRoot - 会话项目根。
 * @returns {string|undefined} 镜像基址绝对路径。
 */
/**
 * 解析一个「项目内默认 + 可自定义」的路径。
 * 空值使用默认相对路径；支持 `<项目>`/`<project>`、相对路径、`~` 与绝对路径。
 * @param {string|undefined} value - 配置值。
 * @param {string|undefined} projectRoot - 会话项目根。
 * @param {string} defaultRelative - 空值时使用的相对路径。
 * @returns {string|undefined} 绝对路径。
 */
export function resolveProjectPath(value, projectRoot, defaultRelative) {
  let input = typeof value === 'string' ? value.trim() : ''
  input = input.replace(/^<项目>[\\/]?/, '').replace(/^<project>[\\/]?/i, '').trim()
  if (input === '') {
    return projectRoot ? normalizePath(join(projectRoot, defaultRelative)) : undefined
  }
  if (input === '~' || input.startsWith('~/') || input.startsWith('~\\')) {
    return expandPath(input, projectRoot)
  }
  if (isAbsolute(input)) return normalizePath(input)
  return projectRoot ? normalizePath(join(projectRoot, input)) : undefined
}

/**
 * 解析镜像基址。
 * @param {string|undefined} suggestDir - 配置值。
 * @param {string|undefined} projectRoot - 会话项目根。
 * @returns {string|undefined} 镜像基址绝对路径。
 */
export function resolveSuggestRoot(suggestDir, projectRoot) {
  return resolveProjectPath(suggestDir, projectRoot, '.agents')
}

/**
 * 解析告警日志路径。
 * 空值或目录写法的基址为 `.agents`；以 `.log` 结尾时按文件处理。
 * @param {string|undefined} auditPath - 配置值。
 * @param {string|undefined} projectRoot - 会话项目根。
 * @param {string} fileName - 目录写法时使用的文件名。
 * @returns {string|undefined} 日志文件绝对路径。
 */
export function resolveAuditPath(auditPath, projectRoot, fileName) {
  const base = resolveProjectPath(auditPath, projectRoot, '.agents')
  if (!base) return undefined
  return /\.log$/i.test(base) ? base : normalizePath(join(base, fileName))
}

/**
 * 把被禁目标映射为项目内镜像路径。
 * 例如 /var/log/x → <suggestRoot>/var/log/x；/private/tmp/x → <suggestRoot>/tmp/x。
 * @param {object} input - 映射参数。
 * @param {string} input.configuredRoot - 配置里的被禁根（如 /tmp）。
 * @param {string} input.resolvedRoot - 被禁根的真实路径（如 /private/tmp）。
 * @param {string} input.target - 目标真实路径。
 * @param {string} input.suggestRoot - 镜像基址（如 <项目>/.agents）。
 * @returns {string|undefined} 镜像路径；参数不完整时返回 undefined。
 */
export function mirrorPath({ configuredRoot, resolvedRoot, target, suggestRoot }) {
  if (!configuredRoot || !resolvedRoot || !target || !suggestRoot) return undefined
  const realTarget = realpathNearest(target)
  const lexicalTarget = normalizePath(target)
  const roots = [normalizePath(resolvedRoot), normalizePath(configuredRoot)]
  const matched = roots.find(root => isPathUnder(realTarget, root) || isPathUnder(lexicalTarget, root))
  if (!matched) return undefined
  const survivor = isPathUnder(realTarget, matched) ? realTarget : lexicalTarget
  const rest = relativeUnder(survivor, matched)
  const rootName = normalizePath(configuredRoot).replace(/^[\\/]+/, '')
  const base = join(suggestRoot, rootName)
  return rest === '' ? base : join(base, rest)
}

/**
 * 构造同步词法判定器；用于 bash 分析与 pre-execute 的兜底。
 * @param {object} options - 判定参数。
 * @param {string[]} [options.blockedDirs] - 被禁根目录（配置形态）。
 * @param {string[]} [options.allowedPaths] - 显式放行目录。
 * @param {string} [options.projectRoot] - 会话项目根。
 * @param {boolean} [options.allowPlatformTemp] - 是否放行 os.tmpdir()。
 * @returns {{classify: (target: string) => object|null, roots: object[]}} 判定器。
 */
export function createLexicalGuard(options = {}) {
  const roots = (options.blockedDirs ?? [])
    .filter(item => typeof item === 'string' && item.trim() !== '')
    .map(configured => ({
      configured: normalizePath(configured),
      resolved: realpathOrSelf(configured),
    }))
    .sort((left, right) => right.resolved.length - left.resolved.length)

  const allowed = (options.allowedPaths ?? [])
    .filter(item => typeof item === 'string' && item.trim() !== '')
    .map(realpathOrSelf)
  if (options.allowPlatformTemp) allowed.push(realpathOrSelf(tmpdir()))

  const projectRoot = options.projectRoot ? realpathOrSelf(options.projectRoot) : undefined

  /** 真实路径解析缓存，避免对同一路径反复做系统调用。 */
  const cache = new Map()

  /**
   * 解析真实路径并缓存。
   * @param {string} value - 路径。
   * @returns {string} 真实路径。
   */
  const realOf = (value) => {
    const key = value
    if (!cache.has(key)) cache.set(key, realpathNearest(key))
    return cache.get(key)
  }

  return {
    roots,
    /**
     * 判定目标是否落在被禁目录内。
     * @param {string} target - 绝对路径；可包含 `..`，按真实路径解析。
     * @returns {object|null} 命中信息；未命中或允许时返回 null。
     */
    classify(target) {
      const real = realOf(target)
      if (isDeviceException(real)) return null
      if (projectRoot && isPathUnder(real, projectRoot)) return null
      for (const allowedRoot of allowed) {
        if (isPathUnder(real, allowedRoot)) return null
      }
      for (const root of roots) {
        if (isPathUnder(real, root.resolved) || isPathUnder(real, root.configured)) {
          return { root: root.configured, configuredRoot: root.configured, resolvedRoot: root.resolved }
        }
      }
      return null
    },
  }
}