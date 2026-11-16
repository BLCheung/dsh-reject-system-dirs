import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createLexicalGuard,
  defaultBlockedDirs,
  isDeviceException,
  isPathUnder,
  isSafeProjectRoot,
  mirrorPath,
  realpathNearest,
  resolveAuditPath,
  resolveSuggestRoot,
} from '../lib/paths.js'

/** 测试用项目根。 */
const PROJECT = '/Users/test/proj'

/**
 * 构造测试用词法判定器。
 * @returns {object} 判定器。
 */
function guard() {
  return createLexicalGuard({
    blockedDirs: ['/tmp', '/var'],
    allowedPaths: [],
    projectRoot: PROJECT,
    allowPlatformTemp: false,
  })
}

test('路径分量包含判断不误伤前缀相同的兄弟目录', () => {
  assert.equal(isPathUnder('/tmp/x', '/tmp'), true)
  assert.equal(isPathUnder('/tmp', '/tmp'), true)
  assert.equal(isPathUnder('/tmpfoo/x', '/tmp'), false)
  assert.equal(isPathUnder(`${PROJECT}/tmp/x`, PROJECT), true)
})

test('系统目录命中与项目内同名目录放行', () => {
  const detector = guard()
  assert.equal(detector.classify('/tmp/x').root, '/tmp')
  assert.equal(detector.classify('/var/log/x').root, '/var')
  assert.equal(detector.classify(`${PROJECT}/tmp/x`), null)
  assert.equal(detector.classify(`${PROJECT}/a/../tmp/x`), null)
})

test('设备节点始终放行', () => {
  assert.equal(isDeviceException('/dev/null'), true)
  assert.equal(isDeviceException('/dev/fd/3'), true)
  assert.equal(isDeviceException('/dev/tty'), false)
  assert.equal(guard().classify('/dev/null'), null)
})

test('镜像路径按配置根还原', () => {
  const mirror = mirrorPath({
    configuredRoot: '/var',
    resolvedRoot: '/var',
    target: '/var/log/x',
    suggestRoot: `${PROJECT}/.agents`,
  })
  assert.equal(mirror, `${PROJECT}/.agents/var/log/x`)
})

test('目标尚不存在时仍按配置根还原镜像', () => {
  const mirror = mirrorPath({
    configuredRoot: '/tmp',
    resolvedRoot: '/private/tmp',
    target: '/tmp/not-created-yet.txt',
    suggestRoot: `${PROJECT}/.agents`,
  })
  assert.equal(mirror, `${PROJECT}/.agents/tmp/not-created-yet.txt`)
})

test('默认清单覆盖系统目录且不含用户目录', () => {
  const dirs = defaultBlockedDirs()
  assert.ok(dirs.includes('/tmp'))
  assert.ok(dirs.includes('/var'))
  assert.ok(dirs.includes('/etc'))
  assert.ok(!dirs.includes('/Users'))
  assert.ok(!dirs.includes('/home'))
})

test('macOS 的 /private/tmp 别名归一到 /tmp', { skip: process.platform !== 'darwin' }, () => {
  const detector = guard()
  assert.equal(detector.classify('/private/tmp/x').root, '/tmp')
  assert.equal(
    mirrorPath({
      configuredRoot: '/tmp',
      resolvedRoot: '/private/tmp',
      target: '/private/tmp/x',
      suggestRoot: `${PROJECT}/.agents`,
    }),
    `${PROJECT}/.agents/tmp/x`,
  )
})

test('符号链接祖先指向系统目录时仍能识别', () => {
  const root = mkdtempSync(join(tmpdir(), 'reject-dirs-'))
  const link = join(root, 'link')
  symlinkSync('/tmp', link)
  try {
    const detector = createLexicalGuard({
      blockedDirs: ['/tmp'],
      allowedPaths: [],
      projectRoot: root,
      allowPlatformTemp: false,
    })
    assert.equal(detector.classify(join(link, 'new.txt')).root, '/tmp')
    assert.ok(realpathNearest(join(link, 'new.txt')).endsWith('/new.txt'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('项目根安全性：系统目录本身与系统根祖先不作为项目根', () => {
  const blocked = ['/tmp', '/var', '/etc']
  const anchor = '/Users/test/proj'
  assert.equal(isSafeProjectRoot('/', blocked, anchor), false)
  assert.equal(isSafeProjectRoot('/private', blocked, anchor), false)
  assert.equal(isSafeProjectRoot('/tmp', blocked, anchor), false)
  assert.equal(isSafeProjectRoot('/var/log', blocked, anchor), false)
  assert.equal(isSafeProjectRoot('/tmp/proj', blocked, '/tmp/proj'), true)
  assert.equal(isSafeProjectRoot('/Users/test/proj', blocked, anchor), true)
  assert.equal(isSafeProjectRoot('/Users/test/other', blocked, anchor), false)
})

test('无锚点或被禁锚点时，被禁目录内的项目根不被信任', () => {
  const blocked = ['/tmp', '/var']
  assert.equal(isSafeProjectRoot('/tmp/sub', blocked), false)
  assert.equal(isSafeProjectRoot('/Users/test/proj', blocked), true)
  assert.equal(isSafeProjectRoot('/tmp/sub', blocked, '/'), false)
  assert.equal(isSafeProjectRoot('/tmp/sub', blocked, '/Users/test/proj'), false)
})

test('镜像基址支持项目相对路径与占位符', () => {
  assert.equal(resolveSuggestRoot('', PROJECT), `${PROJECT}/.agents`)
  assert.equal(resolveSuggestRoot('<项目>/.agents', PROJECT), `${PROJECT}/.agents`)
  assert.equal(resolveSuggestRoot('<项目>/.agents/logs', PROJECT), `${PROJECT}/.agents/logs`)
  assert.equal(resolveSuggestRoot('.agents/logs', PROJECT), `${PROJECT}/.agents/logs`)
  assert.equal(resolveSuggestRoot('/var/mirror', PROJECT), '/var/mirror')
  assert.equal(resolveSuggestRoot('~/mirror', PROJECT), `${homedir()}/mirror`)
  assert.equal(resolveSuggestRoot('.agents/logs', undefined), undefined)
})

test('告警日志路径支持目录、文件与项目占位符', () => {
  const file = 'reject-system-dirs.log'
  assert.equal(resolveAuditPath('', PROJECT, file), `${PROJECT}/.agents/${file}`)
  assert.equal(resolveAuditPath('<项目>/.agents/logs', PROJECT, file), `${PROJECT}/.agents/logs/${file}`)
  assert.equal(resolveAuditPath('.agents/logs', PROJECT, file), `${PROJECT}/.agents/logs/${file}`)
  assert.equal(resolveAuditPath('.agents/logs/guard.log', PROJECT, file), `${PROJECT}/.agents/logs/guard.log`)
  assert.equal(resolveAuditPath('~/logs', PROJECT, file), `${homedir()}/logs/${file}`)
  assert.equal(resolveAuditPath('.agents/logs', undefined, file), undefined)
})