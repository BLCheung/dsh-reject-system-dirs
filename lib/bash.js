/**
 * bash 命令的静态写入分析。
 *
 * 原则是保守：只在能确定「这条命令会把内容写到某个路径」时判定；
 * 变量、子命令、脚本内部的间接写入无法完全解析，按放行处理。
 */

import { basename, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'

import { expandPath, isDeviceException } from './paths.js'

/** 分隔命令段的操作符。 */
const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '(', ')', '\n'])

/** 写重定向操作符。 */
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>'])

/** 读重定向操作符；其后的目标不参与写判定。 */
const READ_REDIRECTS = new Set(['<', '<<', '<<-', '<<<'])

/** 常见只读命令；带写标志时单独处理。 */
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'stat', 'file', 'wc', 'du', 'df',
  'grep', 'rg', 'egrep', 'fgrep', 'which', 'whereis', 'type', 'id', 'whoami',
  'pwd', 'printenv', 'echo', 'printf', 'test', 'true', 'false', 'sleep', 'date',
  'uname', 'hostname', 'ps', 'top', 'lsof', 'md5', 'md5sum', 'shasum',
  'sha256sum', 'diff', 'cmp', 'comm', 'cut', 'sort', 'uniq', 'tr', 'wc',
])

/** 所有操作数都视为写目标的命令。 */
const WRITE_ALL = new Set([
  'rm', 'rmdir', 'mkdir', 'touch', 'truncate', 'chmod', 'chown', 'chgrp',
  'tee', 'shred', 'mkfifo', 'mknod', 'setfacl', 'setxattr', 'unlink',
])

/** 只有最后一个操作数视为写目标的命令。 */
const WRITE_LAST = new Set(['cp', 'mv', 'rsync', 'ln', 'install', 'ditto'])

/** 命令前缀词；跳过它们及其选项后再找真正的命令。 */
const PREFIX_COMMANDS = new Set([
  'sudo', 'env', 'command', 'nohup', 'time', 'exec', 'builtin', 'nice', 'ionice',
])

/** 需要单独吃掉一个值的前缀选项。 */
const PREFIX_VALUE_OPTIONS = new Set(['-u', '-g', '-C', '--chdir', '-n', '-p'])

/** 脚本正文中表示「可能写文件」的迹象。 */
const SCRIPT_WRITE_HINT = /writeFile|appendFile|createWriteStream|write_text|write_bytes|shutil\.|rmtree|unlink|rename|mkdir|open\([^)]*['"][wax+]|\b(?:rm|cp|mv|touch|chmod|chown|tee|dd|tar|curl|wget|unzip|install|rsync)\b/

/**
 * 从命令文本中剥离 heredoc 正文，避免正文被当成命令行解析。
 * @param {string} text - 原始命令。
 * @returns {{text: string, bodies: string[]}} 剩余命令文本与正文列表。
 */
function stripHeredocs(text) {
  const lines = text.split('\n')
  const kept = []
  const bodies = []
  let pending = null
  for (const line of lines) {
    if (pending) {
      if (line.trim() === pending.delimiter) {
        bodies.push({ text: pending.lines.join('\n'), mode: pending.mode })
        pending = null
      } else {
        pending.lines.push(line)
      }
      continue
    }
    const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/)
    if (match) {
      const shell = /(?:^|[\s;&|])(?:bash|sh|zsh|dash)\b[^<]*<<-?/.test(line)
        || /<<-?[^|]*\|\s*(?:bash|sh|zsh|dash)\b/.test(line)
      const script = /(?:^|[\s;&|])(?:python3?|node|perl|ruby|awk)\b[^<]*<<-?/.test(line)
      pending = { delimiter: match[2], lines: [], mode: shell ? 'shell' : script ? 'script' : 'data' }
      kept.push(line.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/, ' '))
    } else {
      kept.push(line)
    }
  }
  if (pending) bodies.push({ text: pending.lines.join('\n'), mode: pending.mode })
  return { text: kept.join('\n'), bodies }
}

/**
 * 把命令文本切成词与操作符。
 * @param {string} text - 命令文本。
 * @returns {Array<{type: 'word'|'op', value: string}>} 词元列表。
 */
function scanTokens(text) {
  const tokens = []
  let current = ''
  let quoted = false
  let i = 0
  const flush = () => {
    if (current !== '' || quoted) tokens.push({ type: 'word', value: current })
    current = ''
    quoted = false
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") {
      quoted = true
      i += 1
      while (i < text.length && text[i] !== "'") {
        current += text[i]
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '"') {
      quoted = true
      i += 1
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          current += text[i + 1]
          i += 2
          continue
        }
        current += text[i]
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < text.length) {
      current += text[i + 1]
      i += 2
      continue
    }
    if (ch === '#' && current === '') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }

    const multi = ['&>>', '&>', '>>', '<<<', '<<-', '<<', '<>', '>|', '&&', '||', '|&', ';;',
      ';', '|', '&', '>', '<', '\n', '(', ')']
    let operator
    for (const candidate of multi) {
      if (text.startsWith(candidate, i)) {
        operator = candidate
        break
      }
    }
    if (operator) {
      flush()
      tokens.push({ type: 'op', value: operator })
      i += operator.length
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  flush()
  return tokens
}

/**
 * 按分隔操作符把词元切成命令段。
 * @param {Array<object>} tokens - 词元列表。
 * @returns {Array<Array<object>>} 命令段列表。
 */
function splitSegments(tokens) {
  const segments = []
  let current = []
  for (const token of tokens) {
    if (token.type === 'op' && SEPARATORS.has(token.value)) {
      if (current.length > 0) segments.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/**
 * 展开简单变量：`$VAR` 与 `${VAR}`。
 * @param {string} value - 原始词。
 * @param {Record<string, string>} env - 变量表。
 * @returns {string} 展开后的词；未知变量保持原样。
 */
function expandVars(value, env) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, plain) => {
    const name = braced ?? plain
    return Object.hasOwn(env, name) ? env[name] : match
  })
}

/**
 * 提取非选项操作数。
 * @param {string[]} args - 命令参数。
 * @returns {string[]} 操作数。
 */
function operands(args) {
  const result = []
  let stop = false
  for (const arg of args) {
    if (stop) {
      result.push(arg)
      continue
    }
    if (arg === '--') {
      stop = true
      continue
    }
    if (arg.startsWith('-') && arg !== '-') continue
    result.push(arg)
  }
  return result
}

/**
 * 从命令参数中取某个选项的值。
 * @param {string[]} args - 命令参数。
 * @param {string[]} names - 选项名，如 ['-o', '--output']。
 * @returns {string[]} 选项值列表。
 */
function optionValues(args, names) {
  const values = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    for (const name of names) {
      if (arg === name && i + 1 < args.length) {
        values.push(args[i + 1])
        i += 1
        break
      }
      if (arg.startsWith(`${name}=`)) {
        values.push(arg.slice(name.length + 1))
        break
      }
    }
  }
  return values
}

/**
 * 把候选路径拼接为绝对路径，保留 `..` 以便按真实路径解析。
 * @param {string} value - 原始路径。
 * @param {string} cwd - 当前工作目录。
 * @returns {string|undefined} 绝对路径。
 */
function absoluteTarget(value, cwd) {
  if (typeof value !== 'string' || value === '') return undefined
  if (value === '.') return cwd
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) return expandPath(value, cwd)
  if (isAbsolute(value)) return value
  return `${cwd.replace(/[\\/]+$/, '')}/${value}`
}

/**
 * 跳过 clone 的值型选项，取出位置参数。
 * @param {string[]} args - clone 之后的参数。
 * @returns {string[]} 位置参数。
 */
function cloneOperands(args) {
  const valueOptions = new Set([
    '-b', '--branch', '-o', '--origin', '-u', '--upload-pack', '--depth',
    '--reference', '--separate-git-dir', '-c', '--config', '--template', '--jobs',
  ])
  const items = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (valueOptions.has(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith('-')) continue
    items.push(arg)
  }
  return items
}

/**
 * 判断命令是否会把内容隐式写到某个目录（未显式给出目标），并返回该目录。
 * @param {string} command - 命令名。
 * @param {string[]} args - 命令参数。
 * @returns {string[]} 隐式写入目录的原始路径；空数组表示无隐式写入。
 */
function implicitWriteDirs(command, args) {
  if (command === 'tar') {
    const extract = args.some(arg => arg === '--extract' || arg === '--get'
      || (/^-[a-zA-Z]+$/.test(arg) && arg.includes('x')))
    const hasDirectory = args.some(arg => arg === '-C' || arg === '--directory'
      || arg.startsWith('--directory=') || (/^-[a-zA-Z]+$/.test(arg) && arg.includes('C')))
    return extract && !hasDirectory ? ['.'] : []
  }
  if (command === 'unzip') return optionValues(args, ['-d']).length === 0 ? ['.'] : []
  if (command === 'git') {
    const workdirs = optionValues(args, ['-C', '--work-tree'])
    const base = workdirs.length > 0 ? workdirs : ['.']
    if (args.includes('init')) return base
    if (args.includes('clone')) {
      const cloneArgs = args.slice(args.indexOf('clone') + 1)
      return cloneOperands(cloneArgs).length < 2 ? base : []
    }
    return []
  }
  if (command === 'npm' || command === 'pnpm' || command === 'yarn') {
    const install = args.some(arg => ['install', 'add', 'ci', 'i'].includes(arg))
    return install && optionValues(args, ['--prefix', '--dir']).length === 0 ? ['.'] : []
  }
  if (command === 'curl') {
    if (!args.some(arg => arg === '-O' || arg === '--remote-name')) return []
    const outputDir = optionValues(args, ['--output-dir'])
    return outputDir.length > 0 ? outputDir : ['.']
  }
  if (command === 'wget') {
    return optionValues(args, ['-O', '--output-document', '-P', '--directory-prefix']).length === 0
      ? ['.']
      : []
  }
  return []
}

/**
 * 把候选目标解析为绝对路径并交给词法判定器。
 * @param {string} raw - 原始目标。
 * @param {{cwd: string, env: Record<string, string>}} state - 当前 shell 状态。
 * @param {object} guard - 词法判定器。
 * @returns {object|null} 命中信息；未命中或无法判定时返回 null。
 */
function checkTarget(raw, state, guard) {
  if (typeof raw !== 'string' || raw === '' || raw.startsWith('-')) return null
  const expanded = expandVars(raw, state.env)
  if (expanded === '' || expanded.includes('$')) return null
  const absolute = absoluteTarget(expanded, state.cwd)
  if (!absolute || isDeviceException(absolute)) return null
  const hit = guard.classify(absolute)
  return hit ? { ...hit, target: absolute } : null
}

/**
 * 逐个检查目标列表。
 * @param {string[]} targets - 原始目标列表。
 * @param {{cwd: string, env: Record<string, string>}} state - 当前 shell 状态。
 * @param {object} guard - 词法判定器。
 * @returns {object|null} 第一个命中。
 */
function firstHit(targets, state, guard) {
  for (const target of targets) {
    const hit = checkTarget(target, state, guard)
    if (hit) return hit
  }
  return null
}

/**
 * 扫描脚本正文中的被禁路径字面量。
 * @param {string} text - 脚本正文。
 * @param {object} guard - 词法判定器。
 * @param {string} mode - bashScan 档位。
 * @returns {object|null} 命中信息。
 */
export function scanScriptText(text, guard, mode) {
  if (mode === 'off' || typeof text !== 'string' || text === '') return null
  const literals = new Set()
  const pattern = /(?:^|[^A-Za-z0-9_./-])((?:\/|~\/)[^\s'"`)\]},;]+)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    literals.add(match[1])
  }
  const hint = SCRIPT_WRITE_HINT.test(text)
  for (const literal of literals) {
    if (literal.startsWith('//')) continue
    const absolute = expandPath(literal, process.cwd())
    if (!absolute) continue
    const hit = guard.classify(absolute)
    if (hit && (mode === 'strict' || hint)) return { ...hit, target: absolute }
  }
  return null
}

/**
 * 分析单个命令段。
 * @param {Array<object>} tokens - 该段的词元。
 * @param {{cwd: string, env: Record<string, string>}} state - shell 状态。
 * @param {object} guard - 词法判定器。
 * @param {string} scanMode - bashScan 档位。
 * @param {number} depth - 递归深度。
 * @returns {object|null} 命中信息。
 */
function analyzeSegment(tokens, state, guard, scanMode, depth) {
  if (depth > 3) return null
  const words = []
  const redirects = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type === 'word') {
      const next = tokens[i + 1]
      if (/^\d+$/.test(token.value) && next && next.type === 'op' && WRITE_REDIRECTS.has(next.value)) continue
      words.push(token.value)
      continue
    }
    if (WRITE_REDIRECTS.has(token.value)) {
      const next = tokens[i + 1]
      if (next && next.type === 'word') {
        redirects.push(next.value)
        i += 1
      }
      continue
    }
    if (READ_REDIRECTS.has(token.value)) i += 1
  }

  let index = 0
  while (index < words.length) {
    const match = words[index].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s)
    if (!match) break
    state.env[match[1]] = expandVars(match[2], state.env)
    index += 1
  }

  const redirectHit = firstHit(redirects, state, guard)
  if (redirectHit) return redirectHit

  while (index < words.length && PREFIX_COMMANDS.has(basename(words[index]))) {
    index += 1
    while (index < words.length && words[index].startsWith('-')) {
      const option = words[index]
      index += 1
      if (PREFIX_VALUE_OPTIONS.has(option) && index < words.length) index += 1
    }
  }
  if (index >= words.length) return null

  const command = basename(words[index])
  const args = words.slice(index + 1)

  if (command === 'export' || command === 'local' || command === 'declare'
    || command === 'readonly' || command === 'typeset') {
    for (const arg of args) {
      const match = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s)
      if (match) state.env[match[1]] = expandVars(match[2], state.env)
    }
    return null
  }

  if (command === 'cd' || command === 'pushd') {
    const target = operands(args)[0]
    if (target) {
      const expanded = expandVars(target, state.env)
      if (expanded !== '' && !expanded.includes('$')) {
        const absolute = expandPath(expanded, state.cwd)
        if (absolute) {
          state.cwd = absolute
          state.env.PWD = absolute
        }
      }
    }
    return null
  }
  if (command === 'popd') return null

  if (READ_ONLY.has(command)) {
    if (command === 'sed' && (args.includes('-i') || args.includes('--in-place'))) {
      return firstHit(operands(args), state, guard)
    }
    return null
  }

  for (const raw of implicitWriteDirs(command, args)) {
    const expanded = expandVars(raw, state.env)
    const absolute = absoluteTarget(expanded, state.cwd)
    if (!absolute) continue
    if (absolute === '/') {
      return { root: '/', configuredRoot: '/', resolvedRoot: '/', target: '/' }
    }
    const hit = guard.classify(absolute)
    if (hit) return { ...hit, target: absolute }
  }

  if (command === 'sed') {
    const inPlace = args.some(arg => arg === '-i' || arg === '--in-place'
      || arg.startsWith('--in-place=') || /^-[a-zA-Z]*i/.test(arg))
    return inPlace ? firstHit(operands(args), state, guard) : null
  }
  if (command === 'chmod' || command === 'chown' || command === 'chgrp') {
    const items = operands(args)
    return firstHit(items.length > 1 ? items.slice(1) : items, state, guard)
  }
  if (WRITE_ALL.has(command)) return firstHit(operands(args), state, guard)
  if (WRITE_LAST.has(command)) {
    const items = operands(args)
    return items.length > 0 ? checkTarget(items[items.length - 1], state, guard) : null
  }
  if (command === 'dd') {
    return firstHit(args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice(3)), state, guard)
  }
  if (command === 'tar') {
    const creating = args.some(item => item === '--create' || item === '--append' || item === '--update'
      || (/^-[a-zA-Z]+$/.test(item) && /[cru]/.test(item)))
    const targets = []
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '-C' || arg === '--directory') targets.push(args[i + 1])
      else if (arg.startsWith('--directory=')) targets.push(arg.slice(12))
      else if (/^-[a-zA-Z]*C/.test(arg) && i + 1 < args.length) targets.push(args[++i])
      else if ((arg === '-f' || arg === '--file') && i + 1 < args.length) {
        if (creating) targets.push(args[i + 1])
        i += 1
      } else if (arg.startsWith('--file=')) {
        if (creating) targets.push(arg.slice(7))
      } else if (/^-[a-zA-Z]*f/.test(arg) && i + 1 < args.length) {
        if (creating) targets.push(args[i + 1])
        i += 1
      }
    }
    return firstHit(targets.filter(Boolean), state, guard)
  }
  if (command === 'unzip') return firstHit(optionValues(args, ['-d']), state, guard)
  if (command === 'curl') return firstHit(optionValues(args, ['-o', '--output']), state, guard)
  if (command === 'wget') {
    return firstHit(optionValues(args, ['-O', '--output-document', '-P', '--directory-prefix']), state, guard)
  }
  if (command === 'git') {
    let cursor = 0
    while (cursor < args.length && (args[cursor] === '-C' || args[cursor] === '--git-dir'
      || args[cursor] === '--work-tree')) cursor += 2
    const subIndex = args.findIndex((arg, i) => i >= cursor && !arg.startsWith('-'))
    if (subIndex === -1) return null
    const sub = args[subIndex]
    if (sub === 'clone') {
      const cloneArgs = args.slice(subIndex + 1)
      const items = cloneOperands(cloneArgs)
      const destination = items.length > 1 ? items[1] : undefined
      return destination ? checkTarget(destination, state, guard) : null
    }
    return null
  }
  if (command === 'npm' || command === 'pnpm' || command === 'yarn') {
    return firstHit(optionValues(args, ['--prefix', '--cache', '--dir']), state, guard)
  }
  if (command === 'mktemp') {
    const base = optionValues(args, ['-p', '--tmpdir'])[0]
      ?? state.env.TMPDIR
      ?? tmpdir()
    return checkTarget(base, state, guard)
  }
  if (command === 'find') {
    const writeLike = args.some(arg => arg === '-delete' || arg === '-exec' || arg === '-execdir')
    if (!writeLike) return null
    return firstHit(operands(args), state, guard)
  }
  if (command === 'xargs') {
    const nested = operands(args)
    if (nested.length === 0) return null
    const nestedHit = analyzeSegment(
      [{ type: 'word', value: nested[0] }, ...nested.slice(1).map(value => ({ type: 'word', value }))],
      state,
      guard,
      scanMode,
      depth + 1,
    )
    return nestedHit
  }
  if (command === 'bash' || command === 'sh' || command === 'zsh' || command === 'dash') {
    const scriptIndex = args.findIndex(arg => arg === '-c' || /^-[a-zA-Z]*c$/.test(arg))
    if (scriptIndex !== -1 && args[scriptIndex + 1] !== undefined) {
      return analyzeBashCommand(args[scriptIndex + 1], {
        cwd: state.cwd,
        guard,
        scanMode,
        depth: depth + 1,
      })
    }
    return null
  }
  if (command === 'python' || command === 'python3' || command === 'node' || command === 'perl' || command === 'ruby') {
    const flagIndex = args.findIndex(arg => arg === '-c' || arg === '-e' || arg === '-E')
    if (flagIndex !== -1 && args[flagIndex + 1] !== undefined) {
      return scanScriptText(args[flagIndex + 1], guard, scanMode)
    }
    return null
  }
  if (command === 'awk' || command === 'gawk') {
    const script = operands(args)[0]
    return script ? scanScriptText(script, guard, scanMode) : null
  }
  if (command === 'eval') {
    return analyzeBashCommand(args.join(' '), { cwd: state.cwd, guard, scanMode, depth: depth + 1 })
  }
  return null
}

/**
 * 分析一条 bash 命令。
 * @param {string} command - 命令文本。
 * @param {object} options - 分析参数。
 * @param {string} [options.cwd] - 命令的初始工作目录。
 * @param {object} options.guard - 词法判定器。
 * @param {string} options.scanMode - bashScan 档位。
 * @param {number} [options.depth] - 递归深度。
 * @returns {object|null} 命中信息；无命中时返回 null。
 */
export function analyzeBashCommand(command, options) {
  if (typeof command !== 'string' || command.trim() === '') return null
  const { scanMode, guard } = options
  const depth = typeof options.depth === 'number' ? options.depth : 0
  if (depth > 3) return null

  const { text, bodies } = stripHeredocs(command)
  const state = { cwd: options.cwd ?? process.cwd(), env: { ...process.env } }
  state.env.PWD = state.cwd
  for (const segment of splitSegments(scanTokens(text))) {
    const hit = analyzeSegment(segment, state, guard, scanMode, depth)
    if (hit) return hit
  }
  for (const body of bodies) {
    if (body.mode === 'data') continue
    const hit = body.mode === 'shell'
      ? analyzeBashCommand(body.text, { cwd: state.cwd, guard, scanMode, depth: depth + 1 })
      : scanScriptText(body.text, guard, scanMode)
    if (hit) return hit
  }
  return null
}