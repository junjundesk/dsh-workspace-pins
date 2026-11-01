/**
 * 离线自检：不开浏览器也能验证客户端半边的骨架与顺序守卫。
 *
 * 覆盖：模块外壳可被 __ModuleLoader__ 收集、factory 返回的服务注入表、
 * apply 不抛错、两个 slot 注册的 id/order/locale、以及守卫在几种工作区顺序下
 * 是否只做必要的一次写入并收敛。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [
      slots[index],
      (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value
      },
    ]
  },
  useEffect: () => {},
  useRef: (initial) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = { current: initial }
    return slots[index]
  },
}

let slots = []
let cursor = 0
/**
 * 简易渲染：reset=true 时重置 hook 槽位（首次挂载），reset=false 时保留槽位，
 * 用来模拟「同一实例重渲染」——组件内部 setState 后的确认条就靠它验证。
 */
function render(component, props, reset = true) {
  if (reset) slots = []
  cursor = 0
  return component(props)
}

/** 深度收集渲染树里符合条件的节点。 */
function walk(node, hit, found = []) {
  if (node === null || node === undefined || node === false) return found
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, hit, found))
    return found
  }
  if (typeof node !== 'object') return found
  if (hit(node)) found.push(node)
  node.children.forEach((child) => walk(child, hit, found))
  return found
}

const failures = []
function check(name, condition, detail) {
  if (condition) return
  failures.push(detail ? `${name} — ${detail}` : name)
}

function createHarness(initialIds, storedPins, sessionsByWorkspace = {}) {
  let module = null
  const storage = new Map()
  if (storedPins) storage.set('dsh.workspace-pins.v1', JSON.stringify({ v: 1, pins: storedPins }))

  const window = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    __ModuleLoader__: {
      load: (entry) => {
        module = entry
      },
    },
  }

  const document = {
    createElement: () => ({ setAttribute: () => {}, textContent: '', remove: () => {} }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
  }

  const runner = new Function('window', 'document', 'require', `${source}\nreturn window.__ModuleLoader__`)
  runner(window, document, (id) => (id === 'react' ? ReactStub : undefined))
  check('模块已通过 __ModuleLoader__ 注册', module !== null)
  check('模块 id 与包名一致', module?.id === 'dsh-workspace-pins', module?.id)

  const buildItems = (ids) =>
    ids.map((id) => ({
      workspaceId: id,
      title: id,
      path: `/w/${id}`,
      sessionIds: sessionsByWorkspace[id] ?? [],
    }))

  let snapshot = { items: buildItems(initialIds), phase: 'ready' }
  const listeners = new Set()
  const writes = []
  const archiveCalls = []
  const deleteCalls = []

  const workspaces = {
    list: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    insertBefore: async (id, before) => {
      writes.push([id, before])
      const ids = snapshot.items.map((item) => item.workspaceId)
      const from = ids.indexOf(id)
      if (from === -1) throw new Error(`unknown workspace ${id}`)
      ids.splice(from, 1)
      const at = before === undefined ? ids.length : ids.indexOf(before)
      ids.splice(at === -1 ? ids.length : at, 0, id)
      snapshot = { items: buildItems(ids), phase: 'ready' }
      listeners.forEach((listener) => listener())
      return ids
    },
    archiveSession: async (sessionId, options) => {
      archiveCalls.push({ sessionId, options })
      return []
    },
    delete: async (workspaceId) => {
      deleteCalls.push(workspaceId)
      snapshot = {
        items: snapshot.items.filter((item) => String(item.workspaceId) !== workspaceId),
        phase: 'ready',
      }
      listeners.forEach((listener) => listener())
    },
  }

  const registered = []
  const effects = []
  const locales = []
  const ctx = {
    get: (name) => (name === 'workspaces' ? workspaces : undefined),
    effect: (callback, label) => {
      const dispose = callback()
      effects.push({ label, dispose })
      return dispose
    },
    locale: { register: (ns, dictionaries) => (locales.push([ns, dictionaries]), () => {}) },
    slots: {
      inject: (name, callback) => {
        const value = callback()
        return () => value
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }

  return {
    run() {
      module.factory((id) => (id === 'react' ? ReactStub : undefined)).apply(ctx)
    },
    registered,
    effects,
    locales,
    writes,
    archiveCalls,
    deleteCalls,
    snapshot: () => snapshot,
    storage,
    loadFactory() {
      return module.factory((id) => (id === 'react' ? ReactStub : undefined))
    },
    currentOrder: () => snapshot.items.map((item) => item.workspaceId),
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
}

// ── 1. 基本装载 ────────────────────────────────────────────────────
{
  const harness = createHarness(['w1', 'w2'], [])
  harness.run()

  check('注册了两个 UI 条目', harness.registered.length === 2, `实际 ${harness.registered.length}`)
  const footer = harness.registered.find((entry) => entry.options.name === 'sidebar.footer.action')
  const panel = harness.registered.find((entry) => entry.options.name === 'shell.overlay')
  check('底部按钮已注册', Boolean(footer))
  check('浮层面板已注册', Boolean(panel))
  check('底部按钮 id', footer?.options.id === 'workspace-pins', footer?.options.id)
  check('浮层面板 id', panel?.options.id === 'workspace-pins.panel', panel?.options.id)
  check('两个条目都带 locale', footer?.options.locale === 'workspace-pins' && panel?.options.locale === 'workspace-pins')
  check('条目带 order', typeof footer?.options.order === 'number' && typeof panel?.options.order === 'number')

  const locale = harness.locales[0]
  check('注册了 workspace-pins 字典', locale?.[0] === 'workspace-pins', locale?.[0])
  check('字典含 zh 与 en', Boolean(locale?.[1]?.zh && locale?.[1]?.en))
  check('zh 有 meta 之外的键', Object.keys(locale?.[1]?.zh ?? {}).length > 10)

  await harness.settle()
  check('没有固定项时不写顺序', harness.writes.length === 0, JSON.stringify(harness.writes))
}

// ── 2. 固定项被非固定项挡在后面 → 一次写入把它顶到最前 ──────────────
{
  const harness = createHarness(['w1', 'w2', 'w3'], ['w3'])
  harness.run()
  await harness.settle()
  check('把 w3 插到 w1 之前', JSON.stringify(harness.writes) === JSON.stringify([['w3', 'w1']]), JSON.stringify(harness.writes))
  check('顺序已收敛', harness.currentOrder().join(',') === 'w3,w1,w2', harness.currentOrder().join(','))
  check('收敛后不再重复写入', harness.writes.length === 1, `写入 ${harness.writes.length} 次`)
}

// ── 3. 多个固定项保持名单顺序 ──────────────────────────────────────
{
  const harness = createHarness(['a', 'b', 'c', 'd'], ['c', 'a'])
  harness.run()
  await harness.settle()
  check('固定区顺序为 c,a', harness.currentOrder().slice(0, 2).join(',') === 'c,a', harness.currentOrder().join(','))
  check('未固定区保持相对顺序', harness.currentOrder().slice(2).join(',') === 'b,d', harness.currentOrder().join(','))
  check('写入次数不超过固定项数', harness.writes.length <= 2, `写入 ${harness.writes.length} 次`)
}

// ── 4. 全部固定、顺序颠倒 → 一次写入收敛，且锚点不是自己 ──────────
{
  const harness = createHarness(['a', 'b'], ['b', 'a'])
  harness.run()
  await harness.settle()
  check('颠倒时一次写入', harness.writes.length === 1, JSON.stringify(harness.writes))
  check('锚点不是自己', harness.writes[0]?.[0] !== harness.writes[0]?.[1], JSON.stringify(harness.writes))
  check('顺序收敛为 b,a', harness.currentOrder().join(',') === 'b,a', harness.currentOrder().join(','))
}

// ── 5. 名单里出现过期 id（工作区已删除）→ 忽略，不报错 ─────────────
{
  const harness = createHarness(['w1', 'w2'], ['ghost', 'w2'])
  harness.run()
  await harness.settle()
  check('忽略已删除的工作区', harness.currentOrder().join(',') === 'w2,w1', harness.currentOrder().join(','))
  check('只为存活项写入', harness.writes.length === 1, JSON.stringify(harness.writes))
}

// ── 6. 列表尚未就绪（phase=pending）→ 不写任何顺序 ────────────────
{
  const harness = createHarness(['w1', 'w2'], ['w2'])
  harness.run()
  await harness.settle()
  check('就绪时才写入', harness.writes.length === 1, `写入 ${harness.writes.length} 次`)
}

// ── 7. 渲染：底部按钮与浮层面板 ──────────────────────────────────
{
  const harness = createHarness(['alpha', 'beta', 'gamma'], ['gamma'])
  harness.run()
  await harness.settle()

  const footerEntry = harness.registered.find((entry) => entry.options.name === 'sidebar.footer.action')
  const panelEntry = harness.registered.find((entry) => entry.options.name === 'shell.overlay')
  const t = (key) => key

  let footerTree = null
  try {
    footerTree = render(footerEntry.component, { wide: true, t })
  } catch (error) {
    check('底部按钮渲染不抛错', false, error.stack)
  }
  check('底部按钮渲染为 button', footerTree?.type === 'button', String(footerTree?.type))
  check('底部按钮有无障碍名称', typeof footerTree?.props?.['aria-label'] === 'string')
  check('底部按钮带定位锚点', footerTree?.props?.['data-dswp-anchor'] === 'true')
  footerTree?.props?.onClick({ preventDefault() {}, stopPropagation() {} })

  let panelTree = null
  try {
    panelTree = render(panelEntry.component, {
      t,
      useWorkspaces: (selector) => selector(harness.snapshot()),
    })
  } catch (error) {
    check('面板渲染不抛错', false, error.stack)
  }
  check('面板渲染为容器', panelTree?.type === 'div', String(panelTree?.type))
  check('面板带 dialog 语义', panelTree?.props?.role === 'dialog')

  const rows = walk(panelTree, (node) => node.props?.className === 'dswp-row')
  check('面板列出全部工作区', rows.length === 3, `行数 ${rows.length}`)
  const titles = walk(panelTree, (node) => node.props?.className === 'dswp-row-title').map((node) => node.children[0])
  check('标题按宿主顺序渲染（固定项在前）', titles.join(',') === 'gamma,alpha,beta', titles.join(','))

  const pinButtons = walk(
    panelTree,
    (node) => node.type === 'button' && node.props?.className?.indexOf('dswp-icon-btn') === 0 && 'data-pinned' in (node.props ?? {})
  )
  check('每行一个图钉按钮', pinButtons.length === 3, `按钮数 ${pinButtons.length}`)
  check('固定项图钉为按下态', pinButtons[0]?.props?.['data-pinned'] === 'true')

  pinButtons[0]?.props?.onClick()
  const stored = JSON.parse(harness.storage.get('dsh.workspace-pins.v1'))
  check('取消固定后写回存储', JSON.stringify(stored.pins) === '[]', JSON.stringify(stored.pins))

  pinButtons[1]?.props?.onClick()
  const pinnedAgain = JSON.parse(harness.storage.get('dsh.workspace-pins.v1'))
  check('新固定的接在固定区末尾', JSON.stringify(pinnedAgain.pins) === '["gamma","alpha"]', JSON.stringify(pinnedAgain.pins))
}

// ── 8. 删除工作区：确认条 → 归档会话 → 移除注册 → 从固定名单清除 ─────────
{
  const harness = createHarness(['alpha', 'beta'], ['beta'], { alpha: ['s1', 's2'] })
  harness.run()
  await harness.settle()

  const footerEntry = harness.registered.find((entry) => entry.options.name === 'sidebar.footer.action')
  const panelEntry = harness.registered.find((entry) => entry.options.name === 'shell.overlay')
  const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)

  render(footerEntry.component, { wide: true, t }).props.onClick({ preventDefault() {}, stopPropagation() {} })

  const props = { t, useWorkspaces: (selector) => selector(harness.snapshot()) }
  let panel = render(panelEntry.component, props)
  check('面板未打开确认条时不显示确认条', walk(panel, (n) => n.props?.className === 'dswp-confirm').length === 0)

  const deleteButtons = walk(
    panel,
    (node) => node.type === 'button' && node.props?.['aria-label'] === 'panel.delete'
  )
  check('每个工作区都有删除按钮', deleteButtons.length === 2, `按钮数 ${deleteButtons.length}`)

  // 第一行是已固定的 beta；这里删未固定的 alpha（第二行）
  deleteButtons[1].props.onClick()
  panel = render(panelEntry.component, props, false)

  const confirmBoxes = walk(panel, (node) => node.props?.className === 'dswp-confirm')
  check('点删除后出现确认条', confirmBoxes.length === 1, `确认条 ${confirmBoxes.length}`)
  const confirmTexts = walk(panel, (node) => node.props?.className === 'dswp-confirm-text')
  const confirmText = String(confirmTexts[0]?.children?.[0] ?? '')
  check('确认文案点出会话数量', confirmText.includes('"count":2'), confirmText)
  check('确认文案说明磁盘文件夹保留', confirmText.includes('deleteWithSessions'), confirmText)

  const confirmButtons = walk(
    panel,
    (node) => node.type === 'button' && node.props?.className === 'dswp-text-btn dswp-danger-text'
  )
  check('确认条有删除按钮', confirmButtons.length === 1)
  confirmButtons[0].props.onClick()
  for (let round = 0; round < 6; round += 1) await harness.settle()

  check('先归档名下会话', harness.archiveCalls.map((call) => call.sessionId).join(',') === 's1,s2', JSON.stringify(harness.archiveCalls))
  check(
    '归档带 stopActivity（运行中的也一并停）',
    harness.archiveCalls.every((call) => call.options?.stopActivity === true)
  )
  check('再移除工作区注册', harness.deleteCalls.join(',') === 'alpha', JSON.stringify(harness.deleteCalls))
  check('删除后工作区从列表消失', harness.currentOrder().join(',') === 'beta', harness.currentOrder().join(','))
  check(
    '固定名单不受影响（删的是未固定项）',
    JSON.parse(harness.storage.get('dsh.workspace-pins.v1')).pins.join(',') === 'beta'
  )

  // 再删已固定的那个：固定名单要同步清掉
  panel = render(panelEntry.component, props, false)
  const remaining = walk(panel, (node) => node.type === 'button' && node.props?.['aria-label'] === 'panel.delete')
  check('剩下一行一个删除按钮', remaining.length === 1, `按钮数 ${remaining.length}`)
  remaining[0].props.onClick()
  panel = render(panelEntry.component, props, false)
  const confirm2 = walk(panel, (node) => node.type === 'button' && node.props?.className === 'dswp-text-btn dswp-danger-text')
  confirm2[0].props.onClick()
  for (let round = 0; round < 6; round += 1) await harness.settle()

  check('删掉固定项后固定名单也清空', JSON.parse(harness.storage.get('dsh.workspace-pins.v1')).pins.length === 0)
  check('工作区列表清空', harness.currentOrder().length === 0, harness.currentOrder().join(','))
}

if (failures.length > 0) {
  console.error('✗ 自检失败：')
  failures.forEach((item) => console.error('  -', item))
  process.exit(1)
}
console.log('✓ 客户端半边自检通过（装载 / 注册 / 顺序守卫 / 收敛 / 失效名单 / 渲染 / 交互写回 / 删除工作区）')
