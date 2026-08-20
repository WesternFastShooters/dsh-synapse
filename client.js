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
      style.textContent = '.dsh-synapse-map-tab{margin-left:4px}.dsh-synapse-canvas{display:flex!important;flex:1 1 auto;min-height:0;height:100%;width:100%}.dsh-synapse-canvas iframe{display:block;width:100%;height:100%;border:0;flex:1;background:#f5f7fa}'
      document.head.append(style)
      const host = document.createElement('div')
      host.className = 'dsh-synapse-host'
      host.innerHTML = '<section class="canvas-view dsh-synapse-canvas"><iframe title="会话地图" src="/synapse/"></iframe></section>'
      document.body.append(host)
      const canvas = host.querySelector('.dsh-synapse-canvas')
      const frame = host.querySelector('iframe')
      let scroll = null
      let dialogContents = null
      let mapVisible = false
      const dialogTab = () => [...document.querySelectorAll('button[role="tab"]')].find(button => button.textContent.trim() === '对话') ?? null
      const scrollContainer = () => [...document.querySelectorAll('div.Md3f7G_scroll')].find(element => element.getClientRects().length > 0) ?? null
      const syncNativeTabs = () => {
        const dialog = dialogTab()
        if (dialog === null) return
        let map = document.querySelector('[data-dsh-synapse-map-tab]')
        if (map === null) {
          map = document.createElement('button')
          map.type = 'button'
          map.role = 'tab'
          map.className = dialog.className
          map.classList.add('dsh-synapse-map-tab')
          map.dataset.dshSynapseMapTab = ''
          map.textContent = '地图'
          dialog.insertAdjacentElement('afterend', map)
          map.addEventListener('click', open)
          dialog.addEventListener('click', close)
        }
        map.className = dialog.className
        map.classList.add('dsh-synapse-map-tab')
        map.setAttribute('aria-selected', String(mapVisible))
        dialog.setAttribute('aria-selected', String(!mapVisible))
      }
      const close = () => {
        if (!mapVisible) return
        if (scroll !== null && dialogContents !== null) scroll.replaceChildren(...dialogContents)
        document.body.append(host)
        scroll = null
        dialogContents = null
        mapVisible = false
        syncNativeTabs()
      }
      const send = (type, payload) => { frame.contentWindow?.postMessage({ source: 'dsh-synapse', type, ...payload }, location.origin) }
      let syncQueued = false
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
        if (syncQueued) return
        syncQueued = true
        queueMicrotask(() => {
          syncQueued = false
          const sessions = sessionSnapshot(ctx)
          const sessionIds = new Set(sessions.map(session => session.id))
          const removedSessionIds = [...knownSessionIds].filter(id => !sessionIds.has(id))
          knownSessionIds = sessionIds
          void fetch('/synapse/api/sessions/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions, removedSessionIds }) }).catch(() => {})
        })
      }
      const syncTheme = () => {
        const dark = document.body?.hasAttribute?.('data-ds-dark-theme') === true
        send('synapse:theme', { dark })
      }
      const syncCurrentSession = () => {
        syncSessions()
        syncLiveSessions()
        syncTheme()
        if (mapVisible) {
          send('synapse:workspaces', { workspaces: workspaceSnapshot(ctx) })
          send('synapse:current-session', { session: currentSession(ctx) })
        }
      }
      const open = () => {
        if (mapVisible) return
        const target = scrollContainer()
        if (target === null) return
        scroll = target
        dialogContents = [...scroll.childNodes]
        scroll.replaceChildren(canvas)
        mapVisible = true
        syncNativeTabs()
        window.requestAnimationFrame(() => {
          send('synapse:map-opened')
          syncCurrentSession()
        })
      }
      const onFrameLoad = () => {
        syncCurrentSession()
        if (mapVisible) send('synapse:map-opened')
      }
      const onMessage = event => {
        if (event.origin !== location.origin || event.data?.source !== 'dsh-synapse') return
        if (event.data.type === 'synapse:close') return close()
        if (event.data.type === 'synapse:map-ready') return
        if (event.data.type === 'synapse:request-current') {
          send('synapse:workspaces', { workspaces: workspaceSnapshot(ctx) })
          return send('synapse:current-session', { session: currentSession(ctx) })
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
      ctx.effect(() => () => {
        tabObserver.disconnect()
        frame.removeEventListener('load', onFrameLoad)
        window.removeEventListener('message', onMessage)
        window.removeEventListener('keydown', onKeyDown)
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
