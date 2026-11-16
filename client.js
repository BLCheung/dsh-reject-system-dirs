/**
 * reject-system-dirs 的浏览器半侧：在插件页的行配置页编辑拦截设置。
 *
 * 注册到 `plugins.row.config`，键为「包名#行 id」；表单值来自
 * `ctx.configForms.get('reject-system-dirs')`。保存后经 ConfigForm.mutate
 * 写入 Host 的 volatile 字段，下一次工具调用即生效，无需重载插件。
 */

window.__ModuleLoader__.load({
  id: 'dsh-reject-system-dirs',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** locale 命名空间。 */
    const NS = 'rejectSystemDirs'

    /** 槽位注册键：包名 + bundle patch 的行 id。 */
    const ROW_KEY = 'dsh-reject-system-dirs#reject-system-dirs'

    /** Config 表单的命名空间，等于 profile 条目的 id。 */
    const SETTINGS_NAMESPACE = 'reject-system-dirs'

    /** 英文文案。 */
    const en = {
      summary: 'Blocked writes into {count} system directories; read logging {readWarn}.',
      summaryDefault: 'Using the platform default directory list; read logging {readWarn}.',
      loggingSection: 'Audit log',
      loggingHint: 'Read warnings and denial logging write to the same JSONL file. Both are off by default; with both off no log file is created.',
      blockingSection: 'Blocking rules',
      on: 'on',
      off: 'off',
      loading: 'Loading configuration…',
      unavailable: 'Configuration is unavailable',
      unavailableHint: 'The Host serves no editable fields for this plugin. It has not started, or its configuration does not declare volatile fields.',
      readOnly: 'The active profile is read-only; changes cannot be saved.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      unsaved: 'You have unsaved changes',
      saveRejected: 'The change was not applied; the configuration may have changed elsewhere. Your draft was kept—try again.',
      saveFailed: 'Saving failed. The change was not applied.',
      invalid: 'Check the blocked and allowed lists; paths must be absolute.',
      readWarn: 'Log reads',
      readWarnHint: 'Reads are never blocked. When enabled, reads of system directories are appended to the audit log at the path below.',
      enabled: 'Enable blocking',
      enabledHint: 'Turning this off disables every blocking rule and every log rule.',
      mode: 'When a system directory is hit',
      modeDeny: 'Block and explain',
      modeWarn: 'Allow and record only',
      modeHint: 'Block: stop the call and return the reason to the agent. Allow: let it run and only write the audit log, useful for spotting false positives first.',
      bashScan: 'Bash command checks',
      bashScanOff: 'Off',
      bashScanStandard: 'Standard',
      bashScanStrict: 'Strict',
      bashScanHint: 'Standard: detect common write commands and redirects. Strict: block when a system path appears anywhere in the command, which may refuse read-only commands. Off: skip command-text analysis.',
      blockedDirs: 'Blocked directories',
      blockedDirsHint: 'One absolute path per line. The built-in platform list is used when empty.',
      allowedPaths: 'Allowed paths',
      allowedPathsHint: 'One absolute path per line; checked before the blocked list.',
      allowPlatformTemp: 'Allow the system temp directory',
      allowPlatformTempHint: 'Allows os.tmpdir() (on macOS the /var/folders directory). Off by default; keep it off unless a workflow truly needs it.',
      suggestDir: 'Mirror base',
      suggestDirHint: 'Base for suggested project-local paths. Empty or <project>/.agents means the project .agents; relative paths resolve against the current project root, e.g. .agents/logs.',
      auditPath: 'Audit log path',
      auditPathHint: 'Audit log file. Empty or <project>/.agents writes <project>/.agents/reject-system-dirs.log; a path ending in .log is used as the file, otherwise it is treated as a directory. Both switches above write here; system directories are refused.',
      denyLog: 'Log denials',
      denyLogHint: 'Denied writes are always blocked and the reason is shown in the session. When enabled, each denial is also appended to the same audit log.',
      denyHint: 'Extra denial note',
      denyHintHint: 'Appended to the denial message shown to the model. Empty adds nothing.',
    }

    /** 中文文案。 */
    const zh = {
      summary: '已拦截写入 {count} 个系统目录；读取日志{readWarn}。',
      summaryDefault: '使用平台默认目录清单；读取日志{readWarn}。',
      loggingSection: '告警日志',
      loggingHint: '读时告警与记录拒绝写入同一份 JSONL 日志；两者默认关闭，都关闭时不生成日志文件。',
      blockingSection: '拦截规则',
      on: '开',
      off: '关',
      loading: '正在加载配置…',
      unavailable: '配置暂不可用',
      unavailableHint: 'Host 没有为该插件提供可编辑字段：插件尚未启动，或配置未声明 volatile 字段。',
      readOnly: '当前 profile 为只读，修改无法保存。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      unsaved: '有未保存的更改',
      saveRejected: '保存未生效（配置可能在别处被修改），草稿已保留，请重试。',
      saveFailed: '保存失败，修改未生效。',
      invalid: '请检查被禁与放行列表；路径必须是绝对路径。',
      readWarn: '读取时写日志',
      readWarnHint: '读取本身不会被拦截。开启后，读取系统目录的操作会追加到下方「日志文件位置」。',
      enabled: '启用拦截',
      enabledHint: '关闭后，所有拦截与日志规则都不再生效。',
      mode: '命中系统目录时',
      modeDeny: '拦截并说明原因',
      modeWarn: '仅写日志、不拦截',
      modeHint: '拦截并说明原因：直接阻止调用，把原因返回给 AI；仅写日志：放行操作，只记录到告警日志，适合先观察是否误杀。',
      bashScan: 'bash 命令检查',
      bashScanOff: '不检查',
      bashScanStandard: '常规',
      bashScanStrict: '严格',
      bashScanHint: '常规：识别常见写入命令与重定向；严格：命令里出现被禁路径就拦截，可能误伤只读命令；不检查：不做命令文本分析。',
      blockedDirs: '被禁目录',
      blockedDirsHint: '每行一个绝对路径；留空使用平台默认清单。',
      allowedPaths: '放行路径',
      allowedPathsHint: '每行一个绝对路径，先于被禁清单判断。',
      allowPlatformTemp: '放行系统临时目录',
      allowPlatformTempHint: '放行 os.tmpdir()（macOS 的 /var/folders 目录）。默认关闭；只有确实需要时才开启。',
      suggestDir: '镜像基址',
      suggestDirHint: '拒绝时给出的项目内替代路径基址。留空或写 <项目>/.agents 表示项目内 .agents；相对路径基于当前项目根，如 .agents/logs。',
      auditPath: '日志文件位置',
      auditPathHint: '告警日志文件。留空或写 <项目>/.agents 时为 <项目>/.agents/reject-system-dirs.log；以 .log 结尾按文件处理，否则按目录处理。上方两个开关都写入这里；系统目录会被拒绝。',
      denyLog: '拒绝时写日志',
      denyLogHint: '写操作是否被拦截由上方「命中系统目录时」决定，与这个开关无关。开启后，每次拒绝会追加到同一份告警日志。',
      denyHint: '附加说明',
      denyHintHint: '追加到返回给模型的拒绝文案末尾；留空不追加。',
    }

    /** 保存时逐字段清空并写入的 volatile 字段。 */
    const FIELDS = [
      'enabled', 'mode', 'readWarn', 'blockedDirs', 'allowedPaths',
      'allowPlatformTemp', 'suggestDir', 'auditPath', 'bashScan', 'denyLog', 'denyHint',
    ]

    /** 控件共用样式；颜色与字体继承主题。 */
    const control = {
      font: 'inherit',
      color: 'inherit',
      background: 'transparent',
      border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
      borderRadius: '6px',
      padding: '6px 8px',
    }

    /** 表单样式。 */
    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '760px' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px' },
      label: { fontWeight: 600, fontSize: '13px' },
      hint: { margin: 0, fontSize: '12px', opacity: 0.7 },
      notice: { margin: 0, fontSize: '12px', opacity: 0.85 },
      error: { margin: 0, fontSize: '12px', fontWeight: 600, borderLeft: '3px solid currentColor', paddingLeft: '8px' },
      input: control,
      textarea: { ...control, minHeight: '120px', resize: 'vertical', fontFamily: 'ui-monospace, monospace' },
      check: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
      checks: { display: 'flex', flexDirection: 'column', gap: '8px' },
      row: { display: 'flex', gap: '16px', flexWrap: 'wrap' },
      rowField: { display: 'flex', flexDirection: 'column', gap: '6px', flex: '1 1 220px' },
      sectionTitle: { margin: '8px 0 0', fontSize: '14px', fontWeight: 700 },
      actions: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
      button: { ...control, padding: '6px 16px', cursor: 'pointer' },
    }

    /**
     * 以文本行解析路径列表。
     * @param {string} text - 文本。
     * @returns {string[]} 路径列表。
     */
    function lines(text) {
      return String(text).split(/\r?\n/).map(item => item.trim()).filter(item => item !== '')
    }

    /**
     * 从配置快照中提取表单字段。
     * @param {{ value?: object }|undefined} snapshot - ConfigForm 快照。
     * @returns {object} 表单字段。
     */
    function readFields(snapshot) {
      const value = snapshot !== null && typeof snapshot === 'object' && snapshot.value !== null
        && typeof snapshot.value === 'object' ? snapshot.value : {}
      const blocked = Array.isArray(value.blockedDirs) ? value.blockedDirs : []
      const allowed = Array.isArray(value.allowedPaths) ? value.allowedPaths : []
      return {
        enabled: value.enabled !== false,
        mode: value.mode === 'warn' ? 'warn' : 'deny',
        readWarn: value.readWarn === true,
        blockedDirsText: blocked.join('\n'),
        allowedPathsText: allowed.join('\n'),
        allowPlatformTemp: value.allowPlatformTemp === true,
        suggestDir: typeof value.suggestDir === 'string' ? value.suggestDir : '',
        auditPath: typeof value.auditPath === 'string' ? value.auditPath : '',
        bashScan: value.bashScan === 'off' || value.bashScan === 'strict' ? value.bashScan : 'standard',
        denyLog: value.denyLog === true,
        denyHint: typeof value.denyHint === 'string' ? value.denyHint : '',
      }
    }

    /**
     * 把草稿收窄为待写入的全量字段。
     * @param {object} draft - 本地草稿。
     * @returns {object|undefined} 字段值；校验失败时返回 undefined。
     */
    function toPayload(draft) {
      const blockedDirs = lines(draft.blockedDirsText)
      const allowedPaths = lines(draft.allowedPathsText)
      const allPaths = [...blockedDirs, ...allowedPaths]
      if (allPaths.some(item => !item.startsWith('/'))) return undefined
      return {
        enabled: draft.enabled,
        mode: draft.mode === 'warn' ? 'warn' : 'deny',
        readWarn: draft.readWarn,
        blockedDirs,
        allowedPaths,
        allowPlatformTemp: draft.allowPlatformTemp,
        suggestDir: draft.suggestDir.trim(),
        auditPath: draft.auditPath.trim(),
        bashScan: draft.bashScan === 'off' || draft.bashScan === 'strict' ? draft.bashScan : 'standard',
        denyLog: draft.denyLog,
        denyHint: draft.denyHint.trim(),
      }
    }

    /**
     * 生成行摘要。
     * @param {object} draft - 本地草稿。
     * @param {Function} t - 文案函数。
     * @returns {string} 摘要。
     */
    function summarize(draft, t) {
      const count = lines(draft.blockedDirsText).length
      const readWarn = draft.readWarn ? t('on') : t('off')
      return count === 0
        ? t('summaryDefault', { readWarn })
        : t('summary', { count, readWarn })
    }

    /**
     * 行配置页。
     * @param {object} props - 槽位 props，含文案函数、视图与配置表单。
     * @returns {import('react').ReactElement|null} 摘要或表单。
     */
    function RejectSystemDirsSettings(props) {
      const { t, view, config } = props
      const formId = React.useId()
      const [snapshot, setSnapshot] = React.useState(() => config.getSnapshot())
      const [draft, setDraft] = React.useState(() => readFields(config.getSnapshot()))
      const [dirty, setDirty] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [saveState, setSaveState] = React.useState('idle')
      const [error, setError] = React.useState('')
      const draftRef = React.useRef(draft)
      const dirtyRef = React.useRef(false)
      const savingRef = React.useRef(false)

      React.useEffect(() => {
        const sync = () => {
          const next = config.getSnapshot()
          setSnapshot(next)
          if (dirtyRef.current || savingRef.current) return
          const fields = readFields(next)
          draftRef.current = fields
          setDraft(fields)
        }
        sync()
        return config.subscribe(sync)
      }, [config])

      /**
       * 更新本地草稿。
       * @param {string} field - 字段名。
       * @param {unknown} value - 新值。
       * @returns {void}
       */
      const edit = (field, value) => {
        const next = { ...draftRef.current, [field]: value }
        draftRef.current = next
        setDraft(next)
        dirtyRef.current = true
        setDirty(true)
        setError('')
        setSaveState('idle')
      }

      /**
       * 保存到 Host。
       * @returns {Promise<void>} 保存结束。
       */
      const save = async () => {
        if (savingRef.current || !dirtyRef.current) return
        const payload = toPayload(draftRef.current)
        if (payload === undefined) {
          setError(t('invalid'))
          setSaveState('failed')
          return
        }
        if (config.getSnapshot().status !== 'ready') {
          setError(t('saveFailed'))
          setSaveState('failed')
          return
        }
        savingRef.current = true
        setSaving(true)
        setError('')
        setSaveState('saving')
        try {
          const revision = config.getSnapshot().revision
          const written = await config.mutate(
            FIELDS.map(field => ({ op: 'set', path: [field], value: payload[field] })),
            revision,
          )
          if (written !== true) {
            setError(t('saveRejected'))
            setSaveState('failed')
            return
          }
          const settled = readFields(config.getSnapshot())
          draftRef.current = settled
          setDraft(settled)
          dirtyRef.current = false
          setDirty(false)
          setSaveState('saved')
        } catch {
          setError(t('saveFailed'))
          setSaveState('failed')
        } finally {
          savingRef.current = false
          setSaving(false)
        }
      }

      const fieldId = name => `${formId}-${name}`

      if (view === 'summary') {
        if (snapshot.status !== 'ready') return null
        return h('span', null, summarize(draft, t))
      }
      if (snapshot.status === 'loading') {
        return h('p', { role: 'status', style: styles.notice }, t('loading'))
      }
      if (snapshot.status === 'unavailable') {
        return h('div', { role: 'status', style: styles.notice },
          h('p', { style: styles.notice }, t('unavailable')),
          h('p', { style: styles.hint }, t('unavailableHint')),
        )
      }

      const disabled = !snapshot.writable || saving
      const status = error || (saveState === 'saved' ? t('saved') : dirty ? t('unsaved') : '')

      return h('div', { style: styles.root },
        snapshot.writable ? null : h('p', { style: styles.notice }, t('readOnly')),

        h('h3', { style: styles.sectionTitle }, t('blockingSection')),

        h('label', { style: styles.check },
          h('input', {
            type: 'checkbox',
            checked: draft.enabled,
            disabled,
            onChange: event => edit('enabled', event.target.checked),
          }),
          t('enabled'),
        ),
        h('p', { style: styles.hint }, t('enabledHint')),

        h('div', { style: styles.row },
          h('div', { style: styles.rowField },
            h('label', { htmlFor: fieldId('mode'), style: styles.label }, t('mode')),
            h('select', {
              id: fieldId('mode'),
              value: draft.mode,
              disabled,
              style: styles.input,
              onChange: event => edit('mode', event.target.value),
            },
            h('option', { value: 'deny' }, t('modeDeny')),
            h('option', { value: 'warn' }, t('modeWarn')),
            ),
            h('p', { style: styles.hint }, t('modeHint')),
          ),
          h('div', { style: styles.rowField },
            h('label', { htmlFor: fieldId('bashScan'), style: styles.label }, t('bashScan')),
            h('select', {
              id: fieldId('bashScan'),
              value: draft.bashScan,
              disabled,
              style: styles.input,
              onChange: event => edit('bashScan', event.target.value),
            },
            h('option', { value: 'off' }, t('bashScanOff')),
            h('option', { value: 'standard' }, t('bashScanStandard')),
            h('option', { value: 'strict' }, t('bashScanStrict')),
            ),
            h('p', { style: styles.hint }, t('bashScanHint')),
          ),
        ),

        h('div', { style: styles.field },
          h('label', { htmlFor: fieldId('blockedDirsText'), style: styles.label }, t('blockedDirs')),
          h('textarea', {
            id: fieldId('blockedDirsText'),
            value: draft.blockedDirsText,
            disabled,
            style: styles.textarea,
            onChange: event => edit('blockedDirsText', event.target.value),
          }),
          h('p', { style: styles.hint }, t('blockedDirsHint')),
        ),

        h('div', { style: styles.field },
          h('label', { htmlFor: fieldId('allowedPathsText'), style: styles.label }, t('allowedPaths')),
          h('textarea', {
            id: fieldId('allowedPathsText'),
            value: draft.allowedPathsText,
            disabled,
            style: styles.textarea,
            onChange: event => edit('allowedPathsText', event.target.value),
          }),
          h('p', { style: styles.hint }, t('allowedPathsHint')),
        ),

        h('div', { style: styles.checks },
          h('label', { style: styles.check },
            h('input', {
              type: 'checkbox',
              checked: draft.allowPlatformTemp,
              disabled,
              onChange: event => edit('allowPlatformTemp', event.target.checked),
            }),
            t('allowPlatformTemp'),
          ),
          h('p', { style: styles.hint }, t('allowPlatformTempHint')),
        ),

        h('div', { style: styles.field },
          h('label', { htmlFor: fieldId('suggestDir'), style: styles.label }, t('suggestDir')),
          h('input', {
            id: fieldId('suggestDir'),
            type: 'text',
            value: draft.suggestDir,
            disabled,
            style: styles.input,
            onChange: event => edit('suggestDir', event.target.value),
          }),
          h('p', { style: styles.hint }, t('suggestDirHint')),
        ),

        h('div', { style: styles.field },
          h('label', { htmlFor: fieldId('denyHint'), style: styles.label }, t('denyHint')),
          h('input', {
            id: fieldId('denyHint'),
            type: 'text',
            value: draft.denyHint,
            disabled,
            style: styles.input,
            onChange: event => edit('denyHint', event.target.value),
          }),
          h('p', { style: styles.hint }, t('denyHintHint')),
        ),

        h('h3', { style: styles.sectionTitle }, t('loggingSection')),
        h('p', { style: styles.hint }, t('loggingHint')),

        h('label', { style: styles.check },
          h('input', {
            type: 'checkbox',
            checked: draft.readWarn,
            disabled,
            onChange: event => edit('readWarn', event.target.checked),
          }),
          t('readWarn'),
        ),
        h('p', { style: styles.hint }, t('readWarnHint')),

        h('label', { style: styles.check },
          h('input', {
            type: 'checkbox',
            checked: draft.denyLog,
            disabled,
            onChange: event => edit('denyLog', event.target.checked),
          }),
          t('denyLog'),
        ),
        h('p', { style: styles.hint }, t('denyLogHint')),

        h('div', { style: styles.field },
          h('label', { htmlFor: fieldId('auditPath'), style: styles.label }, t('auditPath')),
          h('input', {
            id: fieldId('auditPath'),
            type: 'text',
            value: draft.auditPath,
            disabled,
            style: styles.input,
            onChange: event => edit('auditPath', event.target.value),
          }),
          h('p', { style: styles.hint }, t('auditPathHint')),
        ),

        h('div', { style: styles.actions, 'data-save-state': saveState },
          h('button', {
            type: 'button',
            disabled: disabled || !dirty,
            style: styles.button,
            'data-save-button': true,
            onClick: save,
          }, saving ? t('saving') : t('save')),
          status === '' ? null : h('p', {
            role: 'status',
            style: saveState === 'failed' ? styles.error : styles.notice,
          }, status),
        ),
      )
    }

    return {
      /** 所需客户端服务：槽位、配置表单与本地化。 */
      inject: ['slots', 'configForms', 'locale'],

      /**
       * 注册行配置页与文案。
       * @param {object} ctx - 客户端插件上下文。
       * @returns {void}
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }))
        const config = ctx.configForms.get(SETTINGS_NAMESPACE)
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: NS,
          inject: () => ({ config }),
        }, RejectSystemDirsSettings))
      },
    }
  },
})