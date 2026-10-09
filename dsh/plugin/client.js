/**
 * iPhone Use - client half: the live iPhone screen in DSH's right Sidebar.
 *
 * This file IS the shippable browser artifact. DSH's client module system loads
 * plugin code as a closure factory (`window.__ModuleLoader__.load({ id, factory })`,
 * externals resolved through the injected `require` against the shell's frozen
 * module table), so a hand-written factory is a first-class bundle with no
 * build step to drift.
 *
 * The tab registers through the official two-stage path: the type on
 * `ctx.sidebarRightTabs`, the body on the keyed `sidebar.right.pane.tab` slot.
 * Every fact it shows comes from the host half's loopback routes, so the panel
 * and the model read one source of truth.
 *
 * @module dsh-iphone-use/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-iphone-use',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback

    /** The tab type id: this implementation's identity in the tab system. */
    var TAB_ID = 'dsh-iphone-use'
    /** The tab kind, opened by `pua_screen` and the guide. */
    var TAB_KIND = 'iphone-use'
    /** Routes owned by the host half. */
    var ROUTES = {
      state: '/iphone-use/state',
      frame: '/iphone-use/frame',
      action: '/iphone-use/action',
    }
    /** How often the panel polls for a frame while it is live. */
    var POLL_MS = 700

    function t(zh, en) {
      try {
        if (typeof document !== 'undefined' && (document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0) return zh
      } catch (error) {
        /* fall through to English */
      }
      return en
    }

    /** One small inline glyph: a phone outline. */
    function glyph() {
      return h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 7, y: 2.5, width: 10, height: 19, rx: 2.4 }),
        h('line', { x1: 10.5, y1: 5.2, x2: 13.5, y2: 5.2 }))
    }

    /**
     * The live panel.
     *
     * It polls `/iphone-use/frame` for the newest frame and the operation
     * cursor, and posts the three toolbar actions to `/iphone-use/action`.
     * Frames arrive as base64 JPEG; only the most recent one is ever rendered.
     */
    function PhonePanel(props) {
      var useTabInfo = props.useTabInfo
      var tabInfo = useTabInfo ? useTabInfo() : undefined
      var [preview, setPreview] = useState(null)
      var [note, setNote] = useState(null)
      var [busy, setBusy] = useState(false)
      var alive = useRef(true)
      var seqRef = useRef(0)
      var eventRef = useRef(0)

      useEffect(function () {
        alive.current = true
        return function () { alive.current = false }
      }, [])

      useEffect(function () {
        // Polling stops with the tab's own abort signal, so a closed panel
        // never keeps a device stream open.
        var signal = tabInfo && tabInfo.tab ? tabInfo.tab.signal : undefined
        var stopped = false
        function schedule() {
          if (stopped || !alive.current) return
          timer = setTimeout(tick, POLL_MS)
        }
        var timer
        function tick() {
          if (stopped || !alive.current) return
          if (typeof document !== 'undefined' && document.hidden) { schedule(); return }
          fetch(ROUTES.frame + '?after_seq=' + seqRef.current + '&last_event_id=' + eventRef.current, { signal: signal })
            .then(function (response) { return response.json() })
            .then(function (data) {
              if (stopped || !alive.current) return
              if (data && data.frame && data.frame.seq) seqRef.current = data.frame.seq
              if (data && typeof data.last_event_id === 'number') eventRef.current = data.last_event_id
              setPreview(data)
              setNote(null)
            })
            .catch(function (error) {
              if (stopped || !alive.current) return
              if (error && error.name === 'AbortError') return
              setPreview(function (previous) { return previous ? Object.assign({}, previous, { frame: null, frame_available: false }) : { frame: null, frame_available: false } })
              setNote(t('无法连接手机桥接：', 'Cannot reach the phone bridge: ') + String(error && error.message ? error.message : error))
            })
            .then(schedule)
        }
        tick()
        return function () { stopped = true; if (timer) clearTimeout(timer) }
      }, [tabInfo])

      var act = useCallback(function (action) {
        setBusy(true)
        setNote(null)
        fetch(ROUTES.action, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: action }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            if (data && data.error) setNote(String(data.message || data.error))
          })
          .catch(function (error) { setNote(String(error && error.message ? error.message : error)) })
          .then(function () { setBusy(false) })
      }, [])

      var frame = preview && preview.frame ? preview.frame : null
      var paused = Boolean(preview && preview.paused)
      var device = preview && preview.device ? preview.device.model : null
      var live = frame && !paused
      var status = busy
        ? t('正在执行…', 'Working...')
        : paused
          ? (preview.pause_reason === 'authentication'
            ? t('已暂停（认证中）', 'Paused (authenticating)')
            : t('已暂停（设备锁定）', 'Paused (device locked)'))
          : live ? t('实时', 'Live') : t('未连接', 'Offline')

      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, font: 'inherit', color: 'inherit' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--dsh-border, rgba(128,128,128,0.25))', flex: '0 0 auto' } },
          h('span', { style: { display: 'inline-flex', alignItems: 'center' } }, glyph()),
          h('span', { style: { fontWeight: 600, fontSize: 13 } }, device || t('iPhone', 'iPhone')),
          h('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: live ? 0.9 : 0.6 } }, status)),
        h('div', { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b0b0d', overflow: 'hidden' } },
          frame
            ? h('img', {
              alt: t('手机屏幕', 'iPhone screen'),
              src: 'data:' + (frame.mimeType || 'image/jpeg') + ';base64,' + frame.data,
              style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' },
            })
            : h('div', { style: { fontSize: 12, opacity: 0.6, padding: 16, textAlign: 'center' } }, paused ? status : t('等待画面…', 'Waiting for a frame...'))),
        note ? h('div', { style: { flex: '0 0 auto', padding: '6px 10px', fontSize: 11, opacity: 0.8, borderTop: '1px solid var(--dsh-border, rgba(128,128,128,0.25))' } }, note) : null,
        h('div', { style: { flex: '0 0 auto', display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--dsh-border, rgba(128,128,128,0.25))' } },
          h('button', { type: 'button', disabled: busy, onClick: function () { act('refresh') }, style: buttonStyle() }, t('刷新', 'Refresh')),
          h('button', { type: 'button', disabled: busy, onClick: function () { act('home') }, style: buttonStyle() }, t('主屏幕', 'Home')),
          h('button', { type: 'button', disabled: busy, onClick: function () { act('screenshot') }, style: buttonStyle() }, t('截图', 'Screenshot'))))
    }

    function buttonStyle() {
      return {
        flex: '1 1 0',
        padding: '6px 8px',
        fontSize: 12,
        cursor: 'pointer',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))',
        borderRadius: 6,
      }
    }

    /** Register the tab type and its body through the documented two-stage path. */
    function apply(ctx) {
      var define = {
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        title: function () { return t('手机屏幕', 'iPhone Screen') },
        guide: [{
          id: TAB_KIND,
          title: t('手机屏幕', 'iPhone Screen'),
          description: t('查看并接管真实 iPhone 的实时画面。', 'Watch a real iPhone live, and take it over when asked.'),
        }],
      }
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register(define)
      }, 'dsh-iphone-use: tab type')
      // Stage two: the body under the type's own id. The slot owner supplies
      // `useTabInfo` as a framework prop, so this registration declares no
      // hook of its own.
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
          }, PhonePanel)
        })
      }, 'dsh-iphone-use: tab body')
    }

    exports.TAB_ID = TAB_ID
    exports.TAB_KIND = TAB_KIND
    exports.PhonePanel = PhonePanel
    exports.apply = apply
    exports.inject = ['sidebarRightTabs', 'slots', 'sidebarRight']
    return module.exports
  },
})

//# sourceURL=dsh-iphone-use/client.js
