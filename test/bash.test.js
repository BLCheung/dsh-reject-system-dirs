import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { analyzeBashCommand } from '../lib/bash.js'
import { createLexicalGuard } from '../lib/paths.js'

/** 测试用项目根。 */
const PROJECT = '/Users/test/proj'

/**
 * 分析一条命令。
 * @param {string} command - 命令文本。
 * @param {string} [scanMode] - bash 检查档位。
 * @returns {object|null} 命中信息。
 */
function analyze(command, scanMode = 'standard') {
  return analyzeBashCommand(command, {
    cwd: PROJECT,
    guard: createLexicalGuard({
      blockedDirs: ['/tmp', '/var'],
      allowedPaths: [],
      projectRoot: PROJECT,
      allowPlatformTemp: false,
    }),
    scanMode,
  })
}

test('重定向与常见写命令被拦截', () => {
  assert.ok(analyze('echo hi > /tmp/a'))
  assert.ok(analyze('touch /tmp/x'))
  assert.ok(analyze('rm -rf /tmp/x'))
  assert.ok(analyze('cp a /tmp/b'))
  assert.ok(analyze('mv a /var/log/b'))
  assert.ok(analyze('mkdir -p /tmp/a/b'))
  assert.ok(analyze('tee /tmp/a'))
})

test('相对路径按当前工作目录解析，堵住 .. 逃逸', () => {
  assert.ok(analyze('touch ../../../tmp/x'))
  assert.ok(analyze('cd /tmp && touch x'))
  assert.ok(analyze('cd ../../../tmp && touch x'))
})

test('项目内同名目录与只读命令放行', () => {
  assert.equal(analyze(`echo hi > ${PROJECT}/tmp/a`), null)
  assert.equal(analyze('cat /tmp/x'), null)
  assert.equal(analyze('ls -la /var/log'), null)
  assert.equal(analyze('grep foo /etc/hosts'), null)
  assert.equal(analyze(`touch ${PROJECT}/tmp/x`), null)
})

test('下载、解压与克隆的目标路径被拦截', () => {
  assert.ok(analyze('curl -o /tmp/a https://example.com'))
  assert.ok(analyze('wget -O /tmp/a https://example.com'))
  assert.ok(analyze('unzip a.zip -d /tmp/out'))
  assert.ok(analyze('tar -xf a.tar -C /tmp'))
  assert.ok(analyze('git clone https://example.com/x /tmp/repo'))
  assert.ok(analyze('npm install --prefix /tmp/pkg'))
})

test('内联脚本与 heredoc 正文被扫描', () => {
  assert.ok(analyze(`python3 -c 'open("/tmp/x","w")'`))
  assert.ok(analyze(`node -e "require('fs').writeFileSync('/tmp/x','a')"`))
  assert.ok(analyze("bash -c 'touch /tmp/x'"))
  assert.ok(analyze("python3 - <<'EOF'\nopen('/tmp/x','w')\nEOF"))
  assert.equal(analyze(`python3 -c 'open("/tmp/x")'`), null)
})

test('重定向到安全设备放行', () => {
  assert.equal(analyze('echo hi > /dev/null'), null)
})

test('严格档位下出现被禁路径即拦截', () => {
  assert.ok(analyze(`python3 -c 'print("/tmp/x")'`, 'strict'))
  assert.equal(analyze(`python3 -c 'print("/tmp/x")'`, 'standard'), null)
})

test('mktemp 默认落在被禁的临时目录', () => {
  assert.ok(analyze('mktemp -d'))
  assert.ok(analyze('mktemp -p /tmp'))
  assert.equal(analyze(`mktemp -p ${PROJECT}/.agents/tmp`), null)
})

test('find -delete 与 xargs 的写目标被拦截', () => {
  assert.ok(analyze('find /tmp -name x -delete'))
  assert.ok(analyze('xargs rm -rf /tmp/x'))
  assert.equal(analyze('find /tmp -name x'), null)
})

test('注释不会截断后续命令的扫描', () => {
  assert.ok(analyze('# note\ntouch /tmp/x'))
  assert.ok(analyze('echo a && # comment\ntouch /tmp/x'))
})

test('cd 到系统目录后的隐式写入被拦截', () => {
  assert.ok(analyze('cd /tmp && tar -xf a.tar'))
  assert.ok(analyze('cd /tmp/sub && tar -xf a.tar'))
  assert.ok(analyze('cd /tmp && unzip a.zip'))
  assert.ok(analyze('cd /tmp && git clone https://example.com/x'))
  assert.ok(analyze('cd /tmp && wget https://example.com/x'))
  assert.ok(analyze('git -C /tmp/sub clone https://example.com/x'))
  assert.ok(analyze('git -C /tmp/sub init'))
  assert.equal(analyze(`cd /tmp && chmod 755 ${PROJECT}/x`), null)
  assert.equal(analyze(`cd /tmp && curl -O --output-dir ${PROJECT}/out https://example.com/x`), null)
})

test('数据型 heredoc 不作为脚本扫描', () => {
  assert.equal(analyze(`cat > ${PROJECT}/x <<'EOF'\nrm -rf /tmp/x\nEOF`), null)
  assert.ok(analyze("bash <<'EOF'\ntouch /tmp/x\nEOF"))
})

test('export 与 PWD 跟踪支持项目内 TMPDIR 工作流', () => {
  assert.equal(analyze('export TMPDIR="$PWD/.agents/tmp"; mkdir -p "$TMPDIR"'), null)
})

test('从系统目录读取归档并解压到项目内不算写入', () => {
  assert.equal(analyze(`tar --extract --file=/tmp/a.tar -C ${PROJECT}/out`), null)
})

test('参考文件形式的标准命令仍检查目标', () => {
  assert.ok(analyze(`chmod --reference=${PROJECT}/ref /tmp/x`))
})

test('符号链接加 .. 的逃逸按真实路径判定', () => {
  const root = mkdtempSync(join(tmpdir(), 'reject-bash-'))
  symlinkSync('/tmp', join(root, 'link'))
  try {
    const guard = createLexicalGuard({
      blockedDirs: ['/tmp', '/var'],
      allowedPaths: [],
      projectRoot: root,
      allowPlatformTemp: false,
    })
    const hit = analyzeBashCommand('touch link/../tmp/x', { cwd: root, guard, scanMode: 'standard' })
    assert.equal(hit.root, '/tmp')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('同段赋值先于重定向展开', () => {
  assert.ok(analyze('f=/tmp/x; echo hi > "$f"'))
})

test('heredoc 正文通过管道交给 shell 时仍被检查', () => {
  assert.ok(analyze("cat <<'EOF' | bash\ntouch /tmp/x\nEOF"))
})

test('git clone 的选项值不会被当成目标', () => {
  assert.ok(analyze('cd /tmp && git clone -b main https://example.com/x'))
})