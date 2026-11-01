/**
 * dsh-workspace-pins — 客户端半边
 *
 * 解决一个具体的痛点：工作区文件夹一多，侧边栏就要往下翻；而且宿主新建工作区时
 * 是**插到最前面**的，于是常用的那几个会被不断挤下去。
 *
 * 这个插件的做法只有两步，且都复用宿主已有的能力：
 *
 *  1. **顺序守卫**：把「固定的工作区」按固定顺序顶到工作区列表最前面。
 *     写入用的是宿主本来就有的 `workspaces.insertBefore()`（DOM insertBefore 语义），
 *     不新增任何 Host 状态、不改任何内置包。
 *  2. **一个入口**：侧边栏底部（设置旁边）多一个图钉按钮，点开是本插件自己的浮层面板，
 *     在面板里固定/取消固定、调整固定顺序、按名字筛选。
 *
 * 固定的名单存在本机浏览器 localStorage 里；顺序本身写在宿主的工作区注册表里，
 * 所以关掉页面后置顶依然有效，下次打开页面再校正一次即可。
 *
 * 几条纪律：
 *  - `apply()` 里任何一步失败都保持静默（fail-open）：拿不到 workspaces 服务、
 *    读不到 localStorage、宿主拒绝写入 —— 一律什么都不做，绝不影响侧边栏本身。
 *  - 只写自己的 DOM、自己的样式（`dswp-` 前缀），不读别人的节点与 class。
 *  - 所有资源用 `ctx.effect` 注册，卸载即回收。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-pins',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement

    /** Client locale 命名空间（与 register 时一致）。 */
    var NS = 'workspace-pins'
    /** 本机固定名单的存储键；带版本号，将来改结构可平滑回退。 */
    var STORAGE_KEY = 'dsh.workspace-pins.v1'

    // ────────────────────────────────────────────────────────────────
    // 字典（缺省 en，中文单独提供；其余语言回退 en）
    // ────────────────────────────────────────────────────────────────

    var zh = {
      'footer.label': '固定工作区',
      'footer.title': '固定工作区：让常用的工作区一直排在最上面',
      'panel.title': '固定工作区',
      'panel.hint': '固定的工作区始终排在列表最上面；新建的工作区会排在它们之后。',
      'panel.pinned': '已固定',
      'panel.others': '其他工作区',
      'panel.empty': '还没有固定的工作区。点右侧图钉，把常用的固定住。',
      'panel.noWorkspaces': '还没有工作区。',
      'panel.noMatch': '没有匹配的工作区。',
      'panel.filter': '筛选工作区…',
      'panel.pin': '固定',
      'panel.unpin': '取消固定',
      'panel.moveUp': '上移',
      'panel.moveDown': '下移',
      'panel.clear': '全部取消固定',
      'panel.close': '关闭',
      'panel.failed': '宿主拒绝了这次排序，稍后会自动重试。',
    }

    var en = {
      'footer.label': 'Workspace pins',
      'footer.title': 'Workspace pins: keep frequently used workspaces on top',
      'panel.title': 'Workspace pins',
      'panel.hint': 'Pinned workspaces always sit on top; new workspaces land below them.',
      'panel.pinned': 'Pinned',
      'panel.others': 'Other workspaces',
      'panel.empty': 'Nothing pinned yet. Use the pin on the right to keep a workspace on top.',
      'panel.noWorkspaces': 'No workspaces yet.',
      'panel.noMatch': 'No workspace matches.',
      'panel.filter': 'Filter workspaces…',
      'panel.pin': 'Pin',
      'panel.unpin': 'Unpin',
      'panel.moveUp': 'Move up',
      'panel.moveDown': 'Move down',
      'panel.clear': 'Unpin all',
      'panel.close': 'Close',
      'panel.failed': 'The host refused this reorder; it will be retried automatically.',
    }

    // ────────────────────────────────────────────────────────────────
    // 极简快照 store（不引入额外运行时依赖）
    // ────────────────────────────────────────────────────────────────

    function createStore(initial) {
      var value = initial
      var listeners = new Set()
      return {
        get: function () {
          return value
        },
        set: function (next) {
          if (Object.is(value, next)) return
          value = next
          listeners.forEach(function (listener) {
            listener()
          })
        },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () {
            listeners.delete(listener)
          }
        },
      }
    }

    function useStore(store) {
      var pair = React.useState(function () {
        return store.get()
      })
      var value = pair[0]
      var setValue = pair[1]
      React.useEffect(function () {
        setValue(store.get())
        return store.subscribe(function () {
          setValue(store.get())
        })
      }, [store])
      return value
    }

    // ────────────────────────────────────────────────────────────────
    // 固定名单（本机持久化）
    // ────────────────────────────────────────────────────────────────

    function readPins() {
      try {
        var raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return []
        var parsed = JSON.parse(raw)
        var list = parsed && Array.isArray(parsed.pins) ? parsed.pins : []
        var seen = new Set()
        var clean = []
        list.forEach(function (id) {
          if (typeof id !== 'string' || !id || seen.has(id)) return
          seen.add(id)
          clean.push(id)
        })
        return clean
      } catch (error) {
        return []
      }
    }

    function writePins(pins) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, pins: pins }))
      } catch (error) {
        /* 隐私模式等场景下写不了 localStorage：本次会话内仍然生效 */
      }
    }

    var pinsStore = createStore(readPins())
    var panelStore = createStore(false)

    function commitPins(pins) {
      writePins(pins)
      pinsStore.set(pins)
    }

    // ────────────────────────────────────────────────────────────────
    // 顺序守卫
    //
    // 目标顺序：固定的（按名单顺序）在前，其余保持宿主现有相对顺序。
    // 修正方式：从最后一个固定项往前，把它插到「锚点」之前；锚点先取第一个
    // 未固定项（于是固定区整体落在未固定区之前），之后每次换成刚就位的固定项。
    // 已在正确位置的项跳过，所以重复触发只会做必要的写入。
    // ────────────────────────────────────────────────────────────────

    function createGuard(workspaces) {
      var running = false
      var queued = false

      function hostIds() {
        var snapshot = workspaces.list.getSnapshot()
        if (!snapshot || snapshot.phase !== 'ready') return null
        return snapshot.items.map(function (item) {
          return String(item.workspaceId)
        })
      }

      function enforceOnce() {
        var ids = hostIds()
        if (ids === null || ids.length === 0) return Promise.resolve()
        var pins = pinsStore.get()
        var live = pins.filter(function (id) {
          return ids.indexOf(id) !== -1
        })
        if (live.length === 0) return Promise.resolve()

        var inPlace = true
        for (var index = 0; index < live.length; index += 1) {
          if (ids[index] !== live[index]) {
            inPlace = false
            break
          }
        }
        if (inPlace) return Promise.resolve()

        var pinned = new Set(live)
        var anchor
        for (var cursor = 0; cursor < ids.length; cursor += 1) {
          if (!pinned.has(ids[cursor])) {
            anchor = ids[cursor]
            break
          }
        }

        var chain = Promise.resolve()
        live
          .slice()
          .reverse()
          .forEach(function (id) {
            chain = chain.then(function () {
              var current = hostIds()
              if (current === null) return undefined
              var at = current.indexOf(id)
              var anchorAt = anchor === undefined ? current.length : current.indexOf(anchor)
              var settled =
                anchor === undefined ? at === current.length - 1 : at !== -1 && anchorAt !== -1 && at === anchorAt - 1
              var target = anchor
              anchor = id
              if (settled) return undefined
              return Promise.resolve(workspaces.insertBefore(id, target)).catch(function () {
                return undefined
              })
            })
          })
        return chain
      }

      return function enforce() {
        if (running) {
          queued = true
          return
        }
        running = true
        enforceOnce()
          .catch(function () {
            /* fail-open */
          })
          .then(function () {
            running = false
            if (queued) {
              queued = false
              enforce()
            }
          })
      }
    }

    // ────────────────────────────────────────────────────────────────
    // 图标
    // ────────────────────────────────────────────────────────────────

    function PinIcon(props) {
      var filled = props.filled
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        filled
          ? h('path', {
              fill: 'currentColor',
              d: 'M9.6 1.6a1 1 0 0 1 1.4 0l3.4 3.4a1 1 0 0 1-.2 1.6l-1.5.7-2.9 2.9-.4 2.4a.8.8 0 0 1-1.3.5l-2-2-3 3a.8.8 0 0 1-1.1-1.1l3-3-2-2a.8.8 0 0 1 .5-1.3l2.4-.4 2.9-2.9.7-1.5a1 1 0 0 1 .1-.3Z',
            })
          : h('path', {
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinejoin: 'round',
              d: 'M9.4 2.3a.9.9 0 0 1 1.3 0l3 3a.9.9 0 0 1-.2 1.4l-1.4.7-2.8 2.8-.4 2.3a.7.7 0 0 1-1.2.5l-1.9-1.9-3 3a.7.7 0 0 1-1-1l3-3-1.9-1.9a.7.7 0 0 1 .5-1.2l2.3-.4 2.8-2.8.7-1.4a.9.9 0 0 1 .2-.1Z',
            })
      )
    }

    var chevron = function (up) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 12,
          height: 12,
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          d: up ? 'M4 9.5 8 5.5l4 4' : 'M4 6.5 8 10.5l4-4',
        })
      )
    }

    // ────────────────────────────────────────────────────────────────
    // 侧边栏底部按钮
    // ────────────────────────────────────────────────────────────────

    function FooterPinButton(props) {
      var t = typeof props.t === 'function' ? props.t : function (key) { return key }
      var open = useStore(panelStore)
      var pins = useStore(pinsStore)
      var label = t('footer.label')

      // 与旁边的设置/面板图标保持同一形状：只放图标，名称走 title 与 aria-label，
      // 这样侧边栏宽窄两种状态下都不改动原有 footer 布局。
      return h(
        'button',
        {
          type: 'button',
          className: 'dswp-footer-btn',
          'data-dswp-anchor': 'true',
          'data-active': open ? 'true' : 'false',
          'aria-pressed': open,
          'data-pinned-count': pins.length > 0 ? 'true' : 'false',
          title: t('footer.title'),
          'aria-label': label,
          onClick: function (event) {
            event.preventDefault()
            event.stopPropagation()
            panelStore.set(!panelStore.get())
          },
        },
        h(PinIcon, { filled: pins.length > 0 })
      )
    }

    // ────────────────────────────────────────────────────────────────
    // 浮层面板
    // ────────────────────────────────────────────────────────────────

    function PinPanel(props) {
      var open = useStore(panelStore)
      var pins = useStore(pinsStore)
      var useWorkspaces = props.useWorkspaces
      var t = typeof props.t === 'function' ? props.t : function (key) { return key }
      // 只选取 items（快照里引用稳定的那个字段），避免选择器每次返回新对象触发多余渲染。
      var items = useWorkspaces(function (snapshot) {
        return snapshot.items
      }) || []
      var filterPair = React.useState('')
      var filter = filterPair[0]
      var setFilter = filterPair[1]
      var rootRef = React.useRef(null)

      React.useEffect(
        function () {
          if (!open) return undefined
          var onPointerDown = function (event) {
            var root = rootRef.current
            if (!root) return
            if (root.contains(event.target)) return
            var footer = document.querySelector('[data-dswp-anchor="true"]')
            if (footer && footer.contains(event.target)) return
            panelStore.set(false)
          }
          var onKeyDown = function (event) {
            if (event.key === 'Escape') panelStore.set(false)
          }
          document.addEventListener('pointerdown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown, true)
          return function () {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown, true)
          }
        },
        [open]
      )

      if (!open) return null

      var rows = items.map(function (item) {
        return {
          id: String(item.workspaceId),
          title: item.title || item.path || String(item.workspaceId),
          path: item.path || '',
        }
      })
      var byId = new Map()
      rows.forEach(function (row) {
        byId.set(row.id, row)
      })
      var pinnedRows = pins
        .map(function (id) {
          return byId.get(id)
        })
        .filter(Boolean)
      var otherRows = rows.filter(function (row) {
        return pins.indexOf(row.id) === -1
      })

      var query = filter.trim().toLowerCase()
      var match = function (row) {
        if (!query) return true
        return row.title.toLowerCase().indexOf(query) !== -1 || row.path.toLowerCase().indexOf(query) !== -1
      }

      function pin(id) {
        commitPins([id].concat(pins.filter(function (item) {
          return item !== id
        })))
      }

      function unpin(id) {
        commitPins(pins.filter(function (item) {
          return item !== id
        }))
      }

      function move(id, delta) {
        var next = pins.slice()
        var at = next.indexOf(id)
        var to = at + delta
        if (at === -1 || to < 0 || to >= next.length) return
        next.splice(at, 1)
        next.splice(to, 0, id)
        commitPins(next)
      }

      function renderRow(row, index, total) {
        var pinned = pins.indexOf(row.id) !== -1
        return h(
          'div',
          { key: row.id, className: 'dswp-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'dswp-icon-btn',
              'data-pinned': pinned ? 'true' : 'false',
              title: pinned ? t('panel.unpin') : t('panel.pin'),
              'aria-label': pinned ? t('panel.unpin') : t('panel.pin'),
              'aria-pressed': pinned,
              onClick: function () {
                if (pinned) unpin(row.id)
                else pin(row.id)
              },
            },
            h(PinIcon, { filled: pinned })
          ),
          h(
            'div',
            { className: 'dswp-row-text' },
            h('div', { className: 'dswp-row-title' }, row.title),
            h('div', { className: 'dswp-row-path' }, row.path)
          ),
          pinned
            ? [
                h(
                  'button',
                  {
                    key: 'up',
                    type: 'button',
                    className: 'dswp-icon-btn dswp-hover-only',
                    disabled: index === 0,
                    title: t('panel.moveUp'),
                    'aria-label': t('panel.moveUp'),
                    onClick: function () {
                      move(row.id, -1)
                    },
                  },
                  chevron(true)
                ),
                h(
                  'button',
                  {
                    key: 'down',
                    type: 'button',
                    className: 'dswp-icon-btn dswp-hover-only',
                    disabled: index === total - 1,
                    title: t('panel.moveDown'),
                    'aria-label': t('panel.moveDown'),
                    onClick: function () {
                      move(row.id, 1)
                    },
                  },
                  chevron(false)
                ),
              ]
            : null
        )
      }

      var visiblePinned = pinnedRows.filter(match)
      var visibleOthers = otherRows.filter(match)

      return h(
        'div',
        { ref: rootRef, className: 'dswp-panel', role: 'dialog', 'aria-label': t('panel.title') },
        h(
          'div',
          { className: 'dswp-panel-head' },
          h('div', { className: 'dswp-panel-title' }, t('panel.title')),
          h(
            'button',
            {
              type: 'button',
              className: 'dswp-icon-btn',
              title: t('panel.close'),
              'aria-label': t('panel.close'),
              onClick: function () {
                panelStore.set(false)
              },
            },
            h(
              'svg',
              { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, style: { display: 'block' } },
              h('path', {
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                d: 'M4 4l8 8M12 4l-8 8',
              })
            )
          )
        ),
        h('div', { className: 'dswp-panel-hint' }, t('panel.hint')),
        items.length > 6
          ? h('input', {
              className: 'dswp-filter',
              value: filter,
              placeholder: t('panel.filter'),
              'aria-label': t('panel.filter'),
              onChange: function (event) {
                setFilter(event.target.value)
              },
            })
          : null,
        h(
          'div',
          { className: 'dswp-list' },
          items.length === 0 ? h('div', { className: 'dswp-empty' }, t('panel.noWorkspaces')) : null,
          visiblePinned.length > 0
            ? h(
                'div',
                { className: 'dswp-group-label' },
                t('panel.pinned'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dswp-link-btn',
                    onClick: function () {
                      commitPins([])
                    },
                  },
                  t('panel.clear')
                )
              )
            : null,
          visiblePinned.map(function (row, index) {
            return renderRow(row, index, pinnedRows.length)
          }),
          pins.length === 0 && items.length > 0 ? h('div', { className: 'dswp-empty' }, t('panel.empty')) : null,
          visibleOthers.length > 0
            ? h('div', { className: 'dswp-group-label' }, t('panel.others'))
            : null,
          visibleOthers.map(function (row) {
            return renderRow(row, -1, 0)
          }),
          items.length > 0 && visiblePinned.length === 0 && visibleOthers.length === 0
            ? h('div', { className: 'dswp-empty' }, t('panel.noMatch'))
            : null
        )
      )
    }

    // ────────────────────────────────────────────────────────────────
    // 样式
    // ────────────────────────────────────────────────────────────────

    var CSS = [
      '.dswp-footer-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;transition:background .12s ease,color .12s ease}',
      '.dswp-footer-btn[data-active="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}',
      '.dswp-footer-btn[data-pinned-count="true"]{color:var(--dsw-alias-brand-primary)}',
      '.dswp-footer-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dswp-panel{position:fixed;left:10px;bottom:64px;width:344px;max-width:calc(100vw - 24px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.28);pointer-events:auto;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;z-index:20}',
      '.dswp-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 10px 4px 12px}',
      '.dswp-panel-title{font-weight:600;font-size:13px}',
      '.dswp-panel-hint{padding:0 12px 8px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5}',
      '.dswp-filter{margin:0 10px 8px;height:28px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}',
      '.dswp-filter:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dswp-list{overflow:auto;max-height:46vh;padding-bottom:6px}',
      '.dswp-group-label{display:flex;align-items:center;justify-content:space-between;padding:8px 12px 4px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:.02em}',
      '.dswp-row{display:flex;align-items:center;gap:8px;padding:5px 10px 5px 8px;border-radius:8px;margin:0 6px}',
      '.dswp-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dswp-row-text{min-width:0;flex:1}',
      '.dswp-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dswp-row-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:1px}',
      '.dswp-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}',
      '.dswp-icon-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dswp-icon-btn[data-pinned="true"]{color:var(--dsw-alias-brand-primary)}',
      '.dswp-icon-btn:disabled{opacity:.35;cursor:default}',
      '.dswp-hover-only{opacity:0}',
      '.dswp-row:hover .dswp-hover-only,.dswp-row:focus-within .dswp-hover-only{opacity:1}',
      '.dswp-link-btn{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11px;cursor:pointer;padding:0}',
      '.dswp-empty{padding:10px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}',
    ].join('\n')

    // ────────────────────────────────────────────────────────────────
    // 插件入口
    // ────────────────────────────────────────────────────────────────

    return {
      inject: ['slots', 'locale'],
      apply: function (ctx) {
        var workspaces = ctx.get('workspaces')

        ctx.effect(
          function () {
            return ctx.locale.register(NS, { zh: zh, en: en })
          },
          'workspace-pins:dictionaries'
        )

        ctx.effect(function () {
          var element = document.createElement('style')
          element.setAttribute('data-dswp', '')
          element.textContent = CSS
          document.head.appendChild(element)
          return function () {
            element.remove()
          }
        }, 'workspace-pins:styles')

        if (workspaces) {
          var enforce = createGuard(workspaces)

          ctx.effect(
            function () {
              var dispose = workspaces.list.subscribe(function () {
                enforce()
              })
              return dispose
            },
            'workspace-pins:workspace-subscription'
          )

          ctx.effect(
            function () {
              return pinsStore.subscribe(function () {
                enforce()
              })
            },
            'workspace-pins:pins-subscription'
          )

          // 其它标签页改了固定名单：同步过来再校正。
          ctx.effect(
            function () {
              var onStorage = function (event) {
                if (event.key !== STORAGE_KEY) return
                pinsStore.set(readPins())
              }
              window.addEventListener('storage', onStorage)
              return function () {
                window.removeEventListener('storage', onStorage)
              }
            },
            'workspace-pins:storage-sync'
          )

          enforce()
        }

        ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'workspace-pins',
              order: 500,
              locale: NS,
            },
            FooterPinButton
          )
        })

        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'workspace-pins.panel',
              order: 600,
              locale: NS,
            },
            PinPanel
          )
        })
      },
    }
  },
})
