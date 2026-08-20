window.__ModuleLoader__.load({
  id: 'dsh-synapse',
  factory: () => {
    const module = { exports: {} }
    const currentSession = ctx => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const id = snapshot.current
      if (id === undefined) return null
      const session = snapshot.byId[id]
      return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null }
    }
    const sessionSnapshot = ctx => {
      const snapshot = ctx.sessions.list.getSnapshot()
      return snapshot.ids.map(id => {
        const session = snapshot.byId[id]
        return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null, parentId: session.parentId ?? null, blank: session.blank }
      }).filter(Boolean)
    }
    const workspaceSnapshot = ctx => {
      const sessions = ctx.sessions.list.getSnapshot()
      const snapshot = ctx.workspaces.list.getSnapshot()
      const accounted = new Set(snapshot.items.flatMap(workspace => workspace.sessionIds))
      return [
        ...snapshot.items.map(workspace => ({ id: workspace.workspaceId, title: workspace.title, path: workspace.path, sessionIds: workspace.sessionIds })),
        { id: 'dsh-ungrouped', title: '未分组', path: null, sessionIds: sessions.ids.filter(id => !accounted.has(id)) },
      ]
    }

    module.exports.inject = ['sessions', 'workspaces']
    module.exports.apply = ctx => {
      const prompt = async (sessionId, text) => {
        const scope = ctx.sessions.scope(sessionId)
        const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
        if (session === undefined) throw new Error('关联的 DSH 会话已不可用')
        const result = await session.prompt([{ type: 'text', text }], 'queue')
        if (!result.ok) throw new Error(result.error?.message ?? 'DSH 未接受这条消息')
      }
      const style = document.createElement('style')
      style.textContent = '.dsh-synapse-map-tab{margin-left:4px}.dsh-synapse-host{position:fixed;z-index:70;visibility:hidden;pointer-events:none;overflow:hidden;background:var(--ds-color-bg-base,#101216)}.dsh-synapse-host.dsh-synapse-host-visible{visibility:visible;pointer-events:auto}.dsh-synapse-map-root,.dsh-synapse-map-scroll{display:flex!important;flex:1 1 0%!important;min-height:0!important;height:100%!important}.dsh-synapse-map-scroll{padding:0!important}.dsh-synapse-map-body{overflow:hidden!important;scrollbar-gutter:auto!important}.dsh-synapse-map-body>:has([data-slot="conversation.composer"]){display:none!important}.dsh-synapse-canvas{display:flex!important;width:100%;height:100%}.dsh-synapse-canvas iframe{display:block;width:100%;height:100%;border:0;flex:1;background:transparent}'
      document.head.append(style)
      const host = document.createElement('div')
      host.className = 'dsh-synapse-host'
      host.innerHTML = '<section class="canvas-view dsh-synapse-canvas"><iframe title="会话地图" src="/synapse/?embed=canvas"></iframe></section>'
      document.body.append(host)
      const canvas = host.querySelector('.dsh-synapse-canvas')
      const frame = host.querySelector('iframe')
      let scroll = null
      let mapRoot = null
      let conversationScroll = null
      let mapVisible = false
      let mapOpening = false
      let mapOpenRequest = 0
      let nativeActiveClasses = []
      const sessionViews = new Map()
      let selectedSessionId = currentSession(ctx)?.id ?? null
      const dialogTab = () => [...document.querySelectorAll('button[role="tab"]')].find(button => button.textContent.trim() === '对话') ?? null
      const hasClassSuffix = (element, suffix) => element instanceof HTMLElement && [...element.classList].some(name => name.endsWith(suffix))
      const scrollContainer = () => [...document.querySelectorAll('[data-slot="conversation.view"] div')].find(element => hasClassSuffix(element, '_scroll') && element.getClientRects().length > 0) ?? null
      const syncNativeTabs = () => {
        const dialog = dialogTab()
        if (dialog === null) return
        let map = document.querySelector('[data-dsh-synapse-map-tab]')
        if (map === null) {
          map = document.createElement('button')
          map.type = 'button'
          map.role = 'tab'
          map.className = [...dialog.classList].filter(name => !name.toLowerCase().includes('active')).join(' ')
          map.classList.add('dsh-synapse-map-tab')
          map.dataset.dshSynapseMapTab = ''
          map.textContent = '地图'
          dialog.insertAdjacentElement('afterend', map)
          map.addEventListener('click', open)
          dialog.addEventListener('click', close)
        }
        const activeClasses = [...new Set([...nativeActiveClasses, ...dialog.classList].filter(name => name.toLowerCase().includes('active')))]
        nativeActiveClasses = activeClasses
        for (const name of activeClasses) {
          dialog.classList.toggle(name, !mapVisible)
          map.classList.toggle(name, mapVisible)
        }
        map.setAttribute('aria-selected', String(mapVisible))
        dialog.setAttribute('aria-selected', String(!mapVisible))
      }
      const updateHostBounds = () => {
        const viewport = conversationScroll ?? scroll
        if (viewport === null) return false
        const bounds = viewport.getBoundingClientRect()
        if (bounds.width <= 0 || bounds.height <= 0) return false
        host.style.left = `${bounds.left}px`
        host.style.top = `${bounds.top}px`
        host.style.width = `${bounds.width}px`
        host.style.height = `${bounds.height}px`
        return true
      }
      const clearMapLayout = () => {
        host.classList.remove('dsh-synapse-host-visible')
        mapRoot?.classList.remove('dsh-synapse-map-root')
        scroll?.classList.remove('dsh-synapse-map-scroll')
        conversationScroll?.classList.remove('dsh-synapse-map-body')
        for (const property of ['left', 'top', 'width', 'height']) host.style.removeProperty(property)
        scroll = null
        mapRoot = null
        conversationScroll = null
      }
      const prepareMapLayout = () => {
        const target = scrollContainer()
        if (target === null) return false
        scroll = target
        mapRoot = scroll.parentElement
        conversationScroll = scroll.closest('[data-conversation-scroll]')
        mapRoot?.classList.add('dsh-synapse-map-root')
        scroll.classList.add('dsh-synapse-map-scroll')
        conversationScroll?.classList.add('dsh-synapse-map-body')
        return updateHostBounds()
      }
      const close = (remember = true) => {
        mapOpenRequest += 1
        if (!mapVisible) {
          mapOpening = false
          clearMapLayout()
          syncNativeTabs()
          return
        }
        if (remember && selectedSessionId !== null) sessionViews.set(selectedSessionId, 'dialog')
        clearMapLayout()
        mapVisible = false
        mapOpening = false
        syncNativeTabs()
      }
      const send = (type, payload) => { frame.contentWindow?.postMessage({ source: 'dsh-synapse', type, ...payload }, location.origin) }
      let syncQueued = false
      let sessionsSync = Promise.resolve()
      let knownSessionIds = new Set()
      const liveUnsubscribers = new Map()
      const syncLiveSessions = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        for (const id of snapshot.ids) {
          if (liveUnsubscribers.has(id)) continue
          const scope = ctx.sessions.scope(id)
          const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
          if (session === undefined) continue
          const publish = () => {
            if (!mapVisible) return
            const state = session.getSnapshot()
            const text = state.partial?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n') ?? ''
            send('synapse:live-reply', { sessionId: id, running: state.running, text })
          }
          liveUnsubscribers.set(id, session.subscribe(publish))
          publish()
        }
        for (const [id, unsubscribe] of liveUnsubscribers) if (!snapshot.ids.includes(id)) { unsubscribe(); liveUnsubscribers.delete(id) }
      }
      const syncSessions = () => {
        if (syncQueued) return sessionsSync
        syncQueued = true
        sessionsSync = new Promise(resolve => queueMicrotask(() => {
          const sessions = sessionSnapshot(ctx)
          const sessionIds = new Set(sessions.map(session => session.id))
          const removedSessionIds = [...knownSessionIds].filter(id => !sessionIds.has(id))
          knownSessionIds = sessionIds
          fetch('/synapse/api/sessions/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions, removedSessionIds }) })
            .catch(() => {})
            .finally(() => { syncQueued = false; resolve() })
        }))
        return sessionsSync
      }
      const syncTheme = () => {
        const dark = document.body?.hasAttribute?.('data-ds-dark-theme') === true
        send('synapse:theme', { dark })
      }
      const syncCurrentSession = () => {
        const nextSessionId = currentSession(ctx)?.id ?? null
        if (nextSessionId !== selectedSessionId) {
          selectedSessionId = nextSessionId
          if (sessionViews.get(nextSessionId) === 'map') {
            close(false)
            window.requestAnimationFrame(() => {
              if (selectedSessionId === nextSessionId && sessionViews.get(nextSessionId) === 'map') open()
            })
          } else close(false)
        }
        const synced = syncSessions()
        syncLiveSessions()
        syncTheme()
        if (mapVisible) void synced.finally(() => {
          if (!mapVisible) return
          send('synapse:workspaces', { workspaces: workspaceSnapshot(ctx) })
          send('synapse:current-session', { session: currentSession(ctx) })
        })
      }
      const open = () => {
        if (mapVisible || mapOpening) return
        if (selectedSessionId !== null) sessionViews.set(selectedSessionId, 'map')
        if (!prepareMapLayout()) return close(false)
        mapOpening = true
        const requestId = ++mapOpenRequest
        const synced = syncSessions()
        syncTheme()
        void synced.finally(() => {
          if (!mapOpening) return
          send('synapse:workspaces', { workspaces: workspaceSnapshot(ctx) })
          send('synapse:current-session', { session: currentSession(ctx) })
          window.requestAnimationFrame(() => {
            if (mapOpening && requestId === mapOpenRequest) send('synapse:map-opened', { requestId })
          })
        })
      }
      const onFrameLoad = () => {
        syncCurrentSession()
        if (mapVisible) send('synapse:map-opened')
      }
      const onMessage = event => {
        if (event.origin !== location.origin || event.data?.source !== 'dsh-synapse') return
        if (event.data.type === 'synapse:close') return close()
        if (event.data.type === 'synapse:map-ready') {
          if (!mapOpening || mapVisible || event.data.requestId !== mapOpenRequest) return
          const requestId = mapOpenRequest
          window.requestAnimationFrame(() => {
            if (!mapOpening || requestId !== mapOpenRequest) return
            if (!updateHostBounds()) return close(false)
            host.classList.add('dsh-synapse-host-visible')
            mapVisible = true
            mapOpening = false
            syncNativeTabs()
          })
          return
        }
        if (event.data.type === 'synapse:request-current') {
          return void syncSessions().finally(() => {
            send('synapse:workspaces', { workspaces: workspaceSnapshot(ctx) })
            send('synapse:current-session', { session: currentSession(ctx) })
          })
        }
        if (event.data.type === 'synapse:open-session') {
          try { ctx.sessions.open(event.data.sessionId); close() } catch { send('synapse:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
          return
        }
        if (event.data.type === 'synapse:activate-session') {
          // Bidirectional current-session sync: switch DSH's current session
          // without closing the map; the sessions-list subscription re-sends
          // synapse:current-session so the map follows the new highlight.
          try { ctx.sessions.open(event.data.sessionId) } catch { send('synapse:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
          return
        }
        if (event.data.type === 'synapse:fork-session') {
          const atSeq = Number.isInteger(event.data.atSeq) ? event.data.atSeq : undefined
          ctx.sessions.fork({ sessionId: event.data.sessionId, atSeq, increaseTitle: true }).then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('synapse:forked-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? 'DSH 分支' } })
          }).catch(() => { send('synapse:bridge-error', { message: 'DSH 分支创建失败，请确认源会话已经完成当前轮次' }) })
          return
        }
        if (event.data.type === 'synapse:send-message') {
          const text = typeof event.data.text === 'string' ? event.data.text.trim() : ''
          if (text === '') return send('synapse:bridge-error', { requestId: event.data.requestId, message: '消息不能为空' })
          prompt(event.data.sessionId, text).then(() => {
            send('synapse:message-sent', { requestId: event.data.requestId, sessionId: event.data.sessionId })
          }).catch(error => {
            send('synapse:bridge-error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : 'DSH 消息发送失败' })
          })
          return
        }
        if (event.data.type === 'synapse:create-session') {
          const workspaceId = typeof event.data.workspaceId === 'string' && event.data.workspaceId !== '' && event.data.workspaceId !== 'dsh-ungrouped' ? event.data.workspaceId : undefined
          const cwd = typeof event.data.cwd === 'string' && event.data.cwd !== '' ? event.data.cwd : undefined
          const create = workspaceId === undefined ? ctx.sessions.create(cwd === undefined ? {} : { cwd }) : ctx.sessions.create({ workspaceId })
          create.then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('synapse:created-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? '新会话', cwd: snapshot.byId[id]?.cwd ?? cwd ?? null } })
          }).catch(() => { send('synapse:bridge-error', { requestId: event.data.requestId, message: 'DSH 会话创建失败，请先在 DSH 选择工作目录' }) })
        }
      }
      const onKeyDown = event => { if (event.key === 'Escape' && mapVisible) close() }
      // Follow DSH's live theme switch: body[data-ds-dark-theme] is the web
      // client's dark-mode signal, mirrored into the map iframe via synapse:theme.
      const themeObserver = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => syncTheme())
      if (themeObserver !== null && document.body) {
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      }
      const tabObserver = new MutationObserver(syncNativeTabs)
      tabObserver.observe(document.body, { childList: true, subtree: true })
      syncNativeTabs()
      const unsubscribeSessions = ctx.sessions.list.subscribe(syncCurrentSession)
      const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(syncCurrentSession)
      frame.addEventListener('load', onFrameLoad)
      window.addEventListener('message', onMessage)
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('resize', updateHostBounds)
      ctx.effect(() => () => {
        tabObserver.disconnect()
        frame.removeEventListener('load', onFrameLoad)
        window.removeEventListener('message', onMessage)
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('resize', updateHostBounds)
        themeObserver?.disconnect()
        unsubscribeSessions()
        unsubscribeWorkspaces()
        for (const unsubscribe of liveUnsubscribers.values()) unsubscribe()
        host.remove()
        style.remove()
      }, 'synapse: web workspace switch')
    }
    return module.exports
  },
})
