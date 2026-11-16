/**
 * reject-system-dirs：阻止 AI 与子 agent 写入系统内置目录。
 *
 * 主拦截点是 `tools/pre-execute`：全局监听器对所有 agent 生效，命中后返回
 * `deny`，审批无法放行。读操作默认放行，仅在开启「读时告警」时记录。
 */

import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'

import z from '@deepseek-ai/schemastery'

import { AUDIT_FILE_NAME, appendAudit } from './lib/audit.js'
import { analyzeBashCommand, scanScriptText } from './lib/bash.js'
import { resolveOptions } from './lib/options.js'
import {
  createLexicalGuard,
  defaultBlockedDirs,
  expandPath,
  isDeviceException,
  isPathUnder,
  isSafeProjectRoot,
  mirrorPath,
  realpathNearest,
  resolveAuditPath,
  resolveSuggestRoot,
} from './lib/paths.js'

/** 插件名；同时作为 loader 诊断名。 */
export const name = 'reject-system-dirs'

/** 依赖的 Host 服务。 */
export const inject = ['fs', 'sessions', 'workingDirectory', 'tools']

/** 写类工具及其路径字段。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'apply_patch', 'write_file', 'delete_file', 'move_file'])

/** 读类工具及其路径字段。 */
const READ_TOOLS = new Set(['read', 'read_image'])

/** 搜索类工具；路径字段缺省为会话目录。 */
const SEARCH_TOOLS = new Set(['glob', 'grep'])

/** 插件配置；全部字段 volatile，设置页保存后原地生效。 */
export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('Enable system-directory write blocking.')
    .volatile(),
  mode: z.union([z.const('deny'), z.const('warn')]).default('deny')
    .description('Block the call when a system directory is hit, or allow it and only write the audit log.')
    .volatile(),
  readWarn: z.boolean().default(false)
    .description('Record reads of system directories in the audit log; reads are never blocked.')
    .volatile(),
  blockedDirs: z.array(String).default(defaultBlockedDirs())
    .description('Directories whose writes are refused.')
    .volatile(),
  allowedPaths: z.array(String).default([])
    .description('Explicitly allowed directories, checked before the blocked list.')
    .volatile(),
  allowPlatformTemp: z.boolean().default(false)
    .description('Allow os.tmpdir() despite the blocked list.')
    .volatile(),
  suggestDir: z.string().default('')
    .description('Base for mirrored suggestions; empty means <project>/.agents.')
    .volatile(),
  auditPath: z.string().default('')
    .description('JSONL audit log path; empty means <project>/.agents/reject-system-dirs.log.')
    .volatile(),
  bashScan: z.union([z.const('off'), z.const('standard'), z.const('strict')]).default('standard')
    .description('Bash command-text inspection: off, standard, or strict.')
    .volatile(),
  scanUnknownTools: z.boolean().default(false)
    .description('Scan string arguments of unknown tools for blocked absolute paths.')
    .volatile(),
  denyLog: z.boolean().default(false)
    .description('Append denied writes to the audit log; writes are blocked regardless of this switch.')
    .volatile(),
  denyHint: z.string().default('')
    .description('Extra sentence appended to the denial message.')
    .volatile(),
})

/**
 * 判断值是否为普通对象。
 * @param {unknown} value - 待判断值。
 * @returns {boolean} 是否为对象。
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 生成建议的镜像基址。
 * @param {object} options - 归一化配置。
 * @param {string|undefined} projectRoot - 项目根。
 * @returns {string|undefined} 镜像基址。
 */
function suggestRootOf(options, projectRoot) {
  return resolveSuggestRoot(options.suggestDir, projectRoot)
}

/**
 * 把命中信息补齐为镜像路径。
 * @param {object} hit - 命中信息。
 * @param {object} options - 归一化配置。
 * @param {string|undefined} projectRoot - 项目根。
 * @returns {object} 带 mirror 字段的命中信息。
 */
function withMirror(hit, options, projectRoot) {
  const suggestRoot = suggestRootOf(options, projectRoot)
  return {
    ...hit,
    mirror: hit.mirror ?? mirrorPath({
      configuredRoot: hit.configuredRoot ?? hit.root,
      resolvedRoot: hit.resolvedRoot ?? hit.root,
      target: hit.target,
      suggestRoot,
    }),
  }
}

/**
 * 组装拒绝文案。
 * @param {object} input - 文案参数。
 * @param {string} input.tool - 工具名。
 * @param {object} input.hit - 命中信息。
 * @param {string|undefined} input.projectRoot - 项目根。
 * @param {object} input.options - 归一化配置。
 * @returns {string} 拒绝文案。
 */
function formatDeny({ tool, hit, projectRoot, cwd, options }) {
  const action = tool === 'bash' ? '命令写入' : '写入'
  const lines = [
    `[reject-system-dirs] 已阻止${action}系统目录 ${hit.root}（解析为 ${hit.target}）。`,
  ]
  if (projectRoot) lines.push(`该路径不在当前项目根 ${projectRoot} 之内。`)
  else if (cwd) lines.push(`当前工作目录 ${cwd} 不是有效的项目根，不能作为放行依据。`)
  else lines.push('当前调用没有可用的会话工作目录。')
  if (hit.mirror) {
    lines.push(`请改用项目内镜像目录：${hit.mirror}（不存在时请自行 mkdir -p 后重试）。`)
  } else {
    lines.push('请改用项目内目录后重试（默认 <项目>/.agents/）。')
  }
  if (options.denyHint) lines.push(options.denyHint)
  return lines.join('\n')
}

/**
 * 安装拦截逻辑。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} config - {@link Config} 校验后的配置；字段为 volatile 引用。
 * @returns {void}
 */
export function apply(ctx, config) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('reject-system-dirs') : ctx.logger
  /** FsTarget 缓存：同一路径只需解析一次。 */
  const targetCache = new Map()

  /**
   * 写入诊断日志。
   * @param {string} message - 日志文本。
   * @param {...unknown} args - 格式化参数。
   * @returns {void}
   */
  const warn = (message, ...args) => {
    try {
      logger?.warn(message, ...args)
    } catch {
      // 日志失败不影响判定。
    }
  }

  /**
   * 取该调用所属会话的项目根。
   * @param {object} exec - 工具执行上下文。
   * @returns {string|undefined} 项目根绝对路径。
   */
  const projectRootOf = (exec) => {
    const id = exec.agent && typeof exec.agent === 'object' ? exec.agent.id : undefined
    if (!id) return undefined
    const session = ctx.sessions.get(id)
    if (!session) return undefined
    try {
      return ctx.workingDirectory.get(session)
    } catch {
      return undefined
    }
  }

  /**
   * 取会话创建时的目录，作为允许的项目根锚点。
   * @param {object} exec - 工具执行上下文。
   * @returns {string|undefined} 锚点目录。
   */
  const anchorOf = (exec) => {
    const id = exec.agent && typeof exec.agent === 'object' ? exec.agent.id : undefined
    if (!id) return undefined
    let session = ctx.sessions.get(id)
    const seen = new Set()
    while (session?.header?.parentSession) {
      if (seen.has(session.header.parentSession)) break
      seen.add(session.header.parentSession)
      const parent = ctx.sessions.get(session.header.parentSession)
      if (!parent) break
      session = parent
    }
    return session?.header?.cwd
  }

  /**
   * 通过文件系统服务解析路径。
   * @param {string} value - 路径。
   * @param {string|undefined} cwd - 基准目录。
   * @param {AbortSignal|undefined} signal - 取消信号。
   * @returns {Promise<object|undefined>} FsTarget。
   */
  const resolveFs = async (value, cwd, signal) => {
    if (!ctx.fs || typeof ctx.fs.resolve !== 'function') return undefined
    try {
      return await ctx.fs.resolve(value, { cwd, signal })
    } catch {
      return undefined
    }
  }

  /**
   * 取缓存的 FsTarget。
   * @param {string} value - 绝对路径。
   * @returns {Promise<object|undefined>} FsTarget。
   */
  const cachedTarget = (value) => {
    if (!targetCache.has(value)) targetCache.set(value, resolveFs(value))
    return targetCache.get(value)
  }

  /**
   * 取允许根列表。
   * @param {object} options - 归一化配置。
   * @returns {string[]} 允许根。
   */
  const allowedRootsOf = (options) => {
    const roots = [...options.allowedPaths]
    if (options.allowPlatformTemp) roots.push(tmpdir())
    return roots
  }

  /**
   * 构造词法判定器。
   * @param {object} options - 归一化配置。
   * @param {string|undefined} projectRoot - 项目根。
   * @returns {object} 判定器。
   */
  const lexicalGuardOf = (options, projectRoot) => createLexicalGuard({
    blockedDirs: options.blockedDirs,
    allowedPaths: options.allowedPaths,
    projectRoot,
    allowPlatformTemp: options.allowPlatformTemp,
  })

  /**
   * 检查单个目标路径。
   * @param {string} raw - 原始路径。
   * @param {string|undefined} cwd - 基准目录。
   * @param {object} exec - 工具执行上下文。
   * @param {object} options - 归一化配置。
   * @param {string|undefined} projectRoot - 项目根。
   * @returns {Promise<object|null>} 命中信息。
   */
  const checkPath = async (raw, cwd, exec, options, projectRoot) => {
    if (typeof raw !== 'string' || raw.trim() === '') return null
    if (!projectRoot && !cwd && !isAbsolute(raw)) return null

    const target = await resolveFs(raw, cwd, exec.signal)
    if (!target) {
      const absolute = expandPath(raw, cwd)
      if (!absolute || isDeviceException(absolute)) return null
      const hit = lexicalGuardOf(options, projectRoot).classify(absolute)
      return hit ? withMirror({ ...hit, target: absolute }, options, projectRoot) : null
    }

    if (projectRoot) {
      const projectTarget = await cachedTarget(projectRoot)
      if (projectTarget && ctx.fs.contains(projectTarget, target)) return null
    }
    if (isDeviceException(ctx.fs.processPath(target))) return null
    for (const allowed of allowedRootsOf(options)) {
      const allowedTarget = await cachedTarget(allowed)
      if (allowedTarget && ctx.fs.contains(allowedTarget, target)) return null
    }
    for (const blocked of options.blockedDirs) {
      const blockedTarget = await cachedTarget(blocked)
      if (!blockedTarget) continue
      if (!ctx.fs.contains(blockedTarget, target)) continue
      const canonical = ctx.fs.processPath(target)
      return withMirror({
        root: blocked,
        configuredRoot: blocked,
        resolvedRoot: ctx.fs.processPath(blockedTarget),
        target: canonical,
      }, options, projectRoot)
    }
    return null
  }

  /**
   * 收集未知工具中的字符串参数。
   * @param {unknown} value - 参数值。
   * @param {string[]} out - 收集结果。
   * @returns {string[]} 收集结果。
   */
  const collectStrings = (value, out) => {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) collectStrings(item, out)
    } else if (isObject(value)) {
      for (const item of Object.values(value)) collectStrings(item, out)
    }
    return out
  }

  /**
   * 判定一次工具调用。
   * @param {object} exec - 工具执行上下文。
   * @param {object} options - 归一化配置。
   * @param {string|undefined} projectRoot - 项目根。
   * @returns {Promise<object|null>} 命中结果。
   */
  const evaluate = async (exec, options, projectRoot, actualCwd) => {
    const args = isObject(exec.arguments) ? exec.arguments : {}
    const cwd = actualCwd ?? projectRoot

    if (exec.name === 'bash') {
      if (!cwd || options.bashScan === 'off') return null
      const workdir = typeof args.workdir === 'string' && args.workdir.trim() !== ''
        ? expandPath(args.workdir, cwd)
        : cwd
      const hit = analyzeBashCommand(typeof args.command === 'string' ? args.command : '', {
        cwd: workdir ?? cwd,
        guard: lexicalGuardOf(options, projectRoot),
        scanMode: options.bashScan,
      })
      return hit ? withMirror(hit, options, projectRoot) : null
    }

    if (exec.name === 'run_code') {
      if (!cwd) return null
      const code = typeof args.code === 'string' ? args.code : typeof args.source === 'string' ? args.source : ''
      const hit = scanScriptText(code, lexicalGuardOf(options, projectRoot), options.bashScan)
      return hit ? withMirror(hit, options, projectRoot) : null
    }

    if (WRITE_TOOLS.has(exec.name)) {
      const raw = typeof args.file_path === 'string' ? args.file_path : args.path
      const hit = await checkPath(raw, cwd, exec, options, projectRoot)
      return hit ? { hit, kind: 'write' } : null
    }

    if (READ_TOOLS.has(exec.name)) {
      if (!options.readWarn) return null
      const hit = await checkPath(args.file_path, cwd, exec, options, projectRoot)
      return hit ? { hit, kind: 'read' } : null
    }

    if (SEARCH_TOOLS.has(exec.name)) {
      if (!options.readWarn) return null
      const raw = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : cwd
      const hit = await checkPath(raw, cwd, exec, options, projectRoot)
      return hit ? { hit, kind: 'read' } : null
    }

    if (exec.name === 'present' && options.readWarn) {
      const files = Array.isArray(args.files) ? args.files : []
      for (const file of files) {
        const raw = isObject(file) ? file.path : undefined
        const hit = await checkPath(raw, cwd, exec, options, projectRoot)
        if (hit) return { hit, kind: 'read' }
      }
      return null
    }

    if (options.scanUnknownTools) {
      for (const value of collectStrings(exec.arguments, [])) {
        if (!value.startsWith('/')) continue
        const hit = await checkPath(value, cwd, exec, options, projectRoot)
        if (hit) return { hit, kind: 'write' }
      }
    }
    return null
  }

  /**
   * 计算安全的审计文件路径。
   * @param {object} options - 归一化配置。
   * @param {string|undefined} projectRoot - 项目根。
   * @returns {string|undefined} 文件路径；不安全时返回 undefined。
   */
  const auditFileOf = (options, projectRoot) => {
    if (!projectRoot) return undefined
    const file = resolveAuditPath(options.auditPath, projectRoot, AUDIT_FILE_NAME)
    if (!file) return undefined
    const realFile = realpathNearest(file)
    const realProject = realpathNearest(projectRoot)
    if (isPathUnder(realFile, realProject)) return file
    const hit = lexicalGuardOf(options, projectRoot).classify(realFile)
    if (hit) {
      warn('audit skipped: %s is inside system directory %s', realFile, hit.root)
      return undefined
    }
    return file
  }

  /**
   * 组装一条审计记录。
   * @param {object} exec - 工具执行上下文。
   * @param {object} hit - 命中信息。
   * @param {string} kind - write 或 read。
   * @param {object} options - 归一化配置。
   * @returns {object} 记录内容。
   */
  const entryOf = (exec, hit, kind, options) => ({
    ts: new Date().toISOString(),
    session: exec.agent?.id,
    tool: exec.name,
    kind,
    path: hit.target,
    root: hit.root,
    mode: options.mode,
  })

  /**
   * 按配置写入审计日志。
   * @param {object} exec - 工具执行上下文。
   * @param {object} hit - 命中信息。
   * @param {string} kind - write 或 read。
   * @param {object} options - 归一化配置。
   * @param {string|undefined} projectRoot - 项目根。
   * @returns {Promise<void>} 写入结束。
   */
  const writeAudit = async (exec, hit, kind, options, projectRoot) => {
    const shouldWrite = kind === 'read' ? options.readWarn : options.denyLog
    if (!shouldWrite) return
    const filePath = auditFileOf(options, projectRoot)
    if (!filePath) {
      warn('audit skipped: no safe audit path')
      return
    }
    await appendAudit({
      filePath,
      entry: entryOf(exec, hit, kind, options),
      warn: message => warn(message),
    })
  }

  /**
   * 记录一次拒绝或读告警。
   * @param {object} input - 记录参数。
   * @param {object} input.exec - 工具执行上下文。
   * @param {object} input.hit - 命中信息。
   * @param {string} input.kind - write 或 read。
   * @param {object} input.options - 归一化配置。
   * @param {string|undefined} input.projectRoot - 项目根。
   * @returns {Promise<void>} 记录结束。
   */
  const record = async ({ exec, hit, kind, options, projectRoot }) => {
    warn('%s %s -> %s (root %s)', kind === 'read' ? 'read' : 'blocked', exec.name, hit.target, hit.root)
    await writeAudit(exec, hit, kind, options, projectRoot)
  }

  /**
   * 同步词法兜底：pre-execute 被其他监听器短路时仍能拦住明确的绝对路径。
   * @param {object} exec - 工具执行上下文。
   * @returns {{reason: string}|undefined} 拒绝原因。
   */
  const lexicalDenial = (exec) => {
    let options
    try {
      options = resolveOptions(config)
    } catch {
      return undefined
    }
    if (!options.enabled || options.mode === 'warn') return undefined
    const actualRoot = projectRootOf(exec)
    if (!actualRoot) return undefined
    const projectRoot = isSafeProjectRoot(actualRoot, options.blockedDirs, anchorOf(exec))
      ? actualRoot
      : undefined
    const guard = lexicalGuardOf(options, projectRoot)
    const args = isObject(exec.arguments) ? exec.arguments : {}

    if (exec.name === 'bash') {
      if (options.bashScan === 'off') return undefined
      const hit = analyzeBashCommand(typeof args.command === 'string' ? args.command : '', {
        cwd: actualRoot,
        guard,
        scanMode: options.bashScan,
      })
      if (!hit) return undefined
      const mirrored = withMirror(hit, options, projectRoot)
      void writeAudit(exec, mirrored, 'write', options, projectRoot).catch(() => {})
      return { reason: formatDeny({ tool: exec.name, hit: mirrored, projectRoot, cwd: actualRoot, options }) }
    }
    if (WRITE_TOOLS.has(exec.name)) {
      const raw = typeof args.file_path === 'string' ? args.file_path : args.path
      if (typeof raw !== 'string' || !isAbsolute(raw)) return undefined
      const absolute = expandPath(raw)
      if (!absolute || isDeviceException(absolute)) return undefined
      const hit = guard.classify(absolute)
      if (!hit) return undefined
      const mirrored = withMirror({ ...hit, target: absolute }, options, projectRoot)
      void writeAudit(exec, mirrored, 'write', options, projectRoot).catch(() => {})
      return {
        reason: formatDeny({
          tool: exec.name,
          hit: mirrored,
          projectRoot,
          cwd: actualRoot,
          options,
        }),
      }
    }
    return undefined
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    let options
    try {
      options = resolveOptions(config)
    } catch (error) {
      warn('configuration read failed: %s', error instanceof Error ? error.message : String(error))
      return next()
    }
    if (!options.enabled) return next()
    if (exec.signal?.aborted) return next()

    try {
      const actualRoot = projectRootOf(exec)
      const projectRoot = actualRoot && isSafeProjectRoot(actualRoot, options.blockedDirs, anchorOf(exec))
        ? actualRoot
        : undefined
      const result = await evaluate(exec, options, projectRoot, actualRoot)
      if (!result) return next()

      await record({ exec, hit: result.hit, kind: result.kind, options, projectRoot })
      if (result.kind === 'read') return next()
      if (options.mode === 'warn') return next()
      return {
        kind: 'deny',
        reason: formatDeny({ tool: exec.name, hit: result.hit, projectRoot, cwd: actualRoot, options }),
        info: { name: 'REJECT_SYSTEM_DIR', code: 'SYSTEM_DIR_DENIED' },
      }
    } catch (error) {
      warn('evaluation failed: %s', error instanceof Error ? error.message : String(error))
      const denial = lexicalDenial(exec)
      if (!denial) return next()
      return {
        kind: 'deny',
        reason: denial.reason,
        info: { name: 'REJECT_SYSTEM_DIR', code: 'SYSTEM_DIR_DENIED' },
      }
    }
  })

  if (ctx.tools && typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools.guard((exec) => lexicalDenial(exec)))
  }
}