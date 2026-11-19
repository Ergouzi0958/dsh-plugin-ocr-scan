/**
 * OCR Scan — browser half.
 *
 * One component owns all state with plain `useState`. An earlier version kept
 * a module-level store because the bar and the window lived in two different
 * slots; the two subscriptions drifted apart, so buttons in the secondary page
 * updated the store but never repainted. A single component tree removes that
 * whole failure mode.
 *
 * The window is portalled to <body> so it escapes the composer's containing
 * block, which is what previously made it clip instead of centre and let wheel
 * events reach the conversation behind it.
 *
 * Colours come from the host's `--dsw-*` tokens only, so the panel follows the
 * light/dark theme instead of falling back to white.
 */
window.__ModuleLoader__.load({
  id: '@local/ocr-scan',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useState, useRef, useCallback, useEffect } = React;

    const API = '/plugins/ocr-scan';
    const LS_KEY = 'ocr-scan:settings';

    // ---------------------------------------------------------------- theme
    const T = {
      bg: 'var(--dsw-alias-bg-layer-1, #1c1d1f)',
      sunken: 'var(--dsw-alias-bg-layer-2, #17181a)',
      raised: 'var(--dsw-alias-bg-layer-3, #232427)',
      text: 'var(--dsw-alias-label-primary, #e8e9ea)',
      text2: 'var(--dsw-alias-label-secondary, #a8abaf)',
      text3: 'var(--dsw-alias-label-tertiary, #7a7e84)',
      border: 'var(--dsw-alias-border-l2, rgba(255,255,255,.10))',
      soft: 'var(--dsw-alias-border-l1, rgba(255,255,255,.06))',
      accent: 'var(--dsw-alias-brand-primary, #4c8dff)',
      onAccent: 'var(--dsw-alias-label-on-color, #fff)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))',
      danger: 'var(--dsw-alias-state-error-primary, #f16a6a)',
      success: 'var(--dsw-alias-state-success-primary, #43b581)',
      warn: 'var(--dsw-alias-state-warn-primary, #e0a33e)',
      xs: 'var(--dsw-radius-xs, 4px)',
      sm: 'var(--dsw-radius-sm, 8px)',
      md: 'var(--dsw-radius-md, 12px)',
      lg: 'var(--dsw-radius-lg, 16px)',
    };

    const S = {
      bar: (hot) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 12px',
        margin: '6px 0',
        borderRadius: T.md,
        border: `1px solid ${hot ? T.accent : T.border}`,
        background: hot ? T.hover : T.sunken,
        color: T.text2,
        fontSize: 12.5,
        fontFamily: 'inherit',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'border-color .15s, background .15s',
      }),
      iconChip: {
        display: 'grid',
        placeItems: 'center',
        width: 22,
        height: 22,
        borderRadius: T.sm,
        background: T.raised,
        color: T.accent,
        flex: '0 0 auto',
      },
      barTitle: { color: T.text, fontWeight: 550, fontSize: 12.5 },

      backdrop: {
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'rgba(0,0,0,.45)',
        backdropFilter: 'blur(2px)',
        overscrollBehavior: 'contain',
      },
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        width: 'min(540px, 92vw)',
        maxHeight: 'min(780px, 86vh)',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        padding: 18,
        borderRadius: T.lg,
        border: `1px solid ${T.border}`,
        background: T.bg,
        boxShadow: 'var(--dsw-shadow-lv3, 0 18px 56px rgba(0,0,0,.48))',
        color: T.text,
        fontSize: 13,
        fontFamily: 'inherit',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingBottom: 12,
        borderBottom: `1px solid ${T.soft}`,
      },
      headerTitle: { margin: 0, flex: '1 1 auto', fontSize: 14, fontWeight: 600, color: T.text },
      iconBtn: (hot, disabled) => ({
        display: 'grid',
        placeItems: 'center',
        width: 28,
        height: 28,
        padding: 0,
        borderRadius: T.sm,
        border: '1px solid transparent',
        background: hot ? T.hover : 'transparent',
        color: hot ? T.text : T.text2,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'background .15s, color .15s',
      }),

      drop: (hot) => ({
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '30px 18px',
        borderRadius: T.md,
        border: `1.5px dashed ${hot ? T.accent : T.border}`,
        background: hot ? T.hover : T.sunken,
        cursor: 'pointer',
        textAlign: 'center',
        transition: 'border-color .15s, background .15s',
      }),
      dropTitle: { fontWeight: 560, color: T.text, fontSize: 13 },
      hint: { fontSize: 11.5, lineHeight: 1.6, color: T.text3 },
      label: { fontSize: 11.5, color: T.text3, marginBottom: 5 },

      input: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: 12.5,
        padding: '7px 10px',
        borderRadius: T.sm,
        border: `1px solid ${T.border}`,
        background: T.sunken,
        color: T.text,
        outline: 'none',
      },
      btn: (primary, small) => ({
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        border: `1px solid ${primary ? 'transparent' : T.border}`,
        borderRadius: T.sm,
        background: primary ? T.accent : 'transparent',
        color: primary ? T.onAccent : T.text,
        font: 'inherit',
        fontSize: small ? 11.5 : 12.5,
        fontWeight: 500,
        padding: small ? '4px 10px' : '8px 16px',
        cursor: 'pointer',
        transition: 'background .15s, opacity .15s',
      }),

      progressTrack: { height: 5, borderRadius: 999, background: T.raised, overflow: 'hidden' },
      progressFill: (pct) => ({
        height: '100%',
        width: `${pct}%`,
        borderRadius: 999,
        background: T.accent,
        transition: 'width .25s ease',
      }),

      list: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        maxHeight: 160,
        overflowY: 'auto',
        padding: 4,
        borderRadius: T.sm,
        background: T.sunken,
      },
      row: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
        padding: '5px 8px',
        borderRadius: T.xs,
        fontSize: 11.5,
        color: T.text2,
      },
      badge: (tone) => ({
        flex: '0 0 auto',
        fontSize: 10.5,
        padding: '1px 7px',
        borderRadius: 999,
        border: `1px solid ${tone === 'ok' ? T.success : T.border}`,
        color: tone === 'ok' ? T.success : T.text3,
        lineHeight: 1.6,
      }),
      ok: { color: T.success, fontSize: 11.5 },
      err: { color: T.danger, fontSize: 11.5, lineHeight: 1.5 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 },
      divider: { height: 1, background: T.soft },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 10,
        borderRadius: T.sm,
        background: T.sunken,
      },
    };

    // ---------------------------------------------------------------- icons
    const svg = (children, size) =>
      h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true }, children);

    const Icon = {
      upload: (s) =>
        svg(
          [
            h('path', { key: 'a', d: 'M12 16V4m0 0L7 9m5-5l5 5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
            h('path', { key: 'b', d: 'M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
          ],
          s,
        ),
      gear: (s) =>
        svg(
          [
            h('circle', { key: 'c', cx: 12, cy: 12, r: 3.2, stroke: 'currentColor', strokeWidth: 1.7 }),
            h('path', {
              key: 'p',
              d: 'M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.03 1.56V21a2 2 0 11-4 0v-.09A1.7 1.7 0 009 19.4a1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.56-1.03H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.6 1.7 1.7 0 0010.03 3V3a2 2 0 114 0v.09A1.7 1.7 0 0015 4.6a1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9v.09A1.7 1.7 0 0021 10.03H21a2 2 0 110 4h-.09A1.7 1.7 0 0019.4 15z',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              strokeLinejoin: 'round',
            }),
          ],
          s,
        ),
      back: (s) =>
        svg(h('path', { d: 'M15 5l-7 7 7 7', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' }), s),
      close: (s) =>
        svg(h('path', { d: 'M6 6l12 12M18 6L6 18', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' }), s),
      plus: (s) =>
        svg(h('path', { d: 'M12 5v14M5 12h14', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' }), s),
    };

    function IconButton({ label, onPress, disabled, children }) {
      const [hot, setHot] = useState(false);
      return h(
        'button',
        {
          type: 'button',
          title: label,
          'aria-label': label,
          disabled,
          onMouseEnter: () => setHot(true),
          onMouseLeave: () => setHot(false),
          onMouseDown: (e) => e.stopPropagation(),
          onClick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!disabled) onPress();
          },
          style: S.iconBtn(hot, disabled),
        },
        children,
      );
    }

    // ---------------------------------------------------------------- io
    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
    }

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = src;
      });
    }

    /** Crop both ends of the running head and scale them up. Page numbers sit
     *  at the left of even pages and the right of odd ones, and they are the
     *  only reliable key for reading order. */
    /** Downscale before sending. The model reads tables noticeably better at
     *  a 2400px long side than at full scan resolution — at full size it tends
     *  to drop a column header — and the payload shrinks by about a third. */
    const MAX_SIDE = 2400;

    async function shrinkImage(img) {
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const scale = Math.min(1, MAX_SIDE / Math.max(W, H));
      if (scale >= 1 && W * H <= MAX_SIDE * MAX_SIDE) {
        return img.src;
      }
      const w = Math.round(W * scale);
      const hh = Math.round(H * scale);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = hh;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, w, hh);
      return c.toDataURL('image/jpeg', 0.88);
    }

    function headerStrips(img) {
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const y0 = Math.round(H * 0.012);
      const bh = Math.round(H * 0.078);
      const make = (x) => {
        const bw = Math.round(W * 0.3);
        const c = document.createElement('canvas');
        c.width = Math.min(bw * 3, 1600);
        c.height = Math.min(bh * 3, 480);
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, x, y0, bw, bh, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.9).split(',')[1];
      };
      return { left: make(0), right: make(Math.round(W * 0.7)) };
    }

    function naturalKey(name) {
      const m = String(name).match(/\((\d+)\)/);
      return m ? [0, Number(m[1])] : [1, 0];
    }

    // ---------------------------------------------------------------- persist
    /** Settings survive a reload: re-typing the key on every refresh was the
     *  complaint. This is local browser storage, not the plugin config. */
    function loadSaved() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return {};
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : {};
      } catch {
        return {};
      }
    }

    function saveSettings(obj) {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(obj));
      } catch {
        /* private mode: keep it in memory for this session only */
      }
    }

    function Portal({ children }) {
      const hostRef = useRef(null);
      if (!hostRef.current && typeof document !== 'undefined') {
        hostRef.current = document.createElement('div');
        hostRef.current.setAttribute('data-ocr-scan-portal', '');
      }
      useEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;
        document.body.appendChild(host);
        return () => {
          if (host.parentNode) host.parentNode.removeChild(host);
        };
      }, []);
      if (!hostRef.current) return null;
      return ReactDOM.createPortal(children, hostRef.current);
    }

    // ---------------------------------------------------------------- panel
    function Panel() {
      const saved = useRef(loadSaved()).current;

      const [open, setOpen] = useState(false);
      const [view, setView] = useState('main');
      const [files, setFiles] = useState([]);
      const [hot, setHot] = useState(false);
      const [running, setRunning] = useState(false);
      const [progress, setProgress] = useState({ done: 0, total: 0 });
      const [result, setResult] = useState(null);
      const [error, setError] = useState('');

      const [presets, setPresets] = useState([]);
      const [custom, setCustom] = useState(Array.isArray(saved.custom) ? saved.custom : []);
      const [selected, setSelected] = useState(saved.selectedId || '');
      const [apiKey, setApiKey] = useState(saved.apiKey || '');
      const [title, setTitle] = useState(saved.title || '扫描文档');
      const [hostHasKey, setHostHasKey] = useState(false);
      const [draft, setDraft] = useState({ label: '', model: '', endpoint: '' });

      const picker = useRef(null);

      // Persist the things worth keeping across reloads.
      useEffect(() => {
        saveSettings({ apiKey, selectedId: selected, title, custom });
      }, [apiKey, selected, title, custom]);

      useEffect(() => {
        fetch(`${API}/presets`)
          .then((r) => r.json())
          .then((d) => {
            const list = d.presets || [];
            setPresets(list);
            setHostHasKey(Boolean(d.hasKey));
            setSelected((cur) => cur || (list[0] ? list[0].id : ''));
          })
          .catch(() => {});
      }, []);

      // Escape closes the window.
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
          if (e.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [open]);

      const allModels = [...presets, ...custom];
      const current = allModels.find((m) => m.id === selected) || allModels[0] || null;
      const hasKey = Boolean(apiKey.trim()) || hostHasKey;

      const addFiles = useCallback(async (list) => {
        const picked = Array.from(list || []).filter(
          (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|bmp)$/i.test(f.name),
        );
        if (!picked.length) return;
        picked.sort((a, b) => {
          const ka = naturalKey(a.name);
          const kb = naturalKey(b.name);
          return ka[0] - kb[0] || ka[1] - kb[1];
        });
        const next = [];
        for (const f of picked) next.push({ file: f, name: f.name, url: await readAsDataUrl(f) });
        setFiles((prev) => prev.concat(next));
        setError('');
      }, []);

      useEffect(() => {
        const onPaste = (e) => {
          const items = e.clipboardData && e.clipboardData.items;
          if (!items) return;
          const imgs = [];
          for (const it of items) {
            if (it.type && it.type.indexOf('image/') === 0) {
              const f = it.getAsFile();
              if (f) imgs.push(f);
            }
          }
          if (imgs.length) addFiles(imgs);
        };
        window.addEventListener('paste', onPaste);
        return () => window.removeEventListener('paste', onPaste);
      }, [addFiles]);

      const run = async () => {
        if (!files.length || running) return;
        if (!hasKey) {
          setError('还没有填写 API Key，点右上角齿轮去设置');
          return;
        }
        setRunning(true);
        setResult(null);
        setError('');
        setProgress({ done: 0, total: files.length });
        try {
          const pages = [];
          for (let i = 0; i < files.length; i += 1) {
            const img = await loadImage(files[i].url);
            // Folio crops come from the full-resolution image (digits are
            // small); the OCR body uses the downscaled copy.
            const strips = headerStrips(img);
            const body = await shrinkImage(img);
            pages.push({
              imageB64: body.slice(body.indexOf(',') + 1),
              headLeft: strips.left,
              headRight: strips.right,
              name: files[i].name,
            });
          }
          const started = await fetch(`${API}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              pages,
              model: current ? current.model : '',
              endpoint: current ? current.endpoint : '',
              title,
              apiKey: apiKey.trim(),
            }),
          });
          const data = await started.json();
          if (!started.ok) throw new Error(data.error || '启动失败');

          for (;;) {
            await new Promise((r) => setTimeout(r, 700));
            const r = await fetch(`${API}/status?id=${encodeURIComponent(data.id)}`);
            if (!r.ok) throw new Error('读取进度失败');
            const job = await r.json();
            setProgress({ done: job.done, total: job.total });
            if (job.state === 'done') {
              setResult(job.output);
              break;
            }
            if (job.state === 'failed') throw new Error(job.error || '识别失败');
          }
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setRunning(false);
        }
      };

      const addCustomModel = () => {
        const label = draft.label.trim() || draft.model.trim();
        const model = draft.model.trim();
        const endpoint = draft.endpoint.trim();
        if (!label || !model || !endpoint) {
          setError('显示名称、模型 ID、接口地址都要填');
          return;
        }
        const item = { id: 'custom-' + Date.now(), label, model, endpoint, custom: true };
        setCustom((prev) => prev.concat(item));
        setSelected(item.id);
        setDraft({ label: '', model: '', endpoint: '' });
        setError('');
      };

      const removeCustom = (id) => {
        setCustom((prev) => prev.filter((m) => m.id !== id));
        if (selected === id) setSelected(presets[0] ? presets[0].id : '');
      };

      const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

      // ---------------------------------------------------------- dock bar
      const dockBar = h(
        'div',
        {
          style: S.bar(hot),
          role: 'button',
          tabIndex: 0,
          onClick: () => setOpen(true),
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') setOpen(true);
          },
          onDragOver: (e) => {
            e.preventDefault();
            setHot(true);
          },
          onDragLeave: () => setHot(false),
          onDrop: (e) => {
            e.preventDefault();
            setHot(false);
            setOpen(true);
            addFiles(e.dataTransfer && e.dataTransfer.files);
          },
        },
        h('span', { style: S.iconChip }, Icon.upload(13)),
        h('span', { style: S.barTitle }, '扫描件转 Markdown'),
        h(
          'span',
          { style: { flex: '1 1 auto', color: T.text3 } },
          running ? `识别中 ${progress.done}/${progress.total}` : result ? '已完成' : '拖入图片或点击打开',
        ),
        running ? h('div', { style: { ...S.progressTrack, width: 80 } }, h('div', { style: S.progressFill(pct) })) : null,
      );

      // ---------------------------------------------------------- backdrop
      const backdrop = {
        style: S.backdrop,
        onClick: (e) => {
          if (e.target === e.currentTarget) setOpen(false);
        },
        onWheel: (e) => {
          const panel = e.currentTarget.firstElementChild;
          if (panel && panel.contains(e.target)) return;
          e.preventDefault();
          e.stopPropagation();
        },
      };

      const closeBtn = (label) =>
        h(IconButton, { label, onPress: () => setOpen(false) }, Icon.close(15));

      // ---------------------------------------------------------- settings
      const settingsView = h(
        'div',
        backdrop,
        h(
          'div',
          { style: S.panel, onClick: (e) => e.stopPropagation(), onWheel: (e) => e.stopPropagation() },
          h(
            'div',
            { style: S.header },
            h(IconButton, { label: '返回', onPress: () => setView('main') }, Icon.back(16)),
            h('h3', { style: S.headerTitle }, '模型设置'),
            closeBtn('关闭'),
          ),

          // API key first: it is why people open this page.
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { ...S.label, marginBottom: 0, color: T.text2 } }, 'API Key'),
              h(
                'span',
                { style: S.badge(apiKey.trim() || hostHasKey ? 'ok' : '') },
                apiKey.trim() ? '已保存' : hostHasKey ? '来自插件配置' : '未填写',
              ),
            ),
            h('input', {
              style: S.input,
              type: 'password',
              value: apiKey,
              placeholder: hostHasKey ? '插件配置里已有，可留空' : 'ak-...',
              onChange: (e) => setApiKey(e.target.value),
              disabled: running,
            }),
            h(
              'div',
              { style: S.hint },
              '保存于本机浏览器，刷新和重启后不用重填。也可以写进插件设置 apiKey 或环境变量 OCR_SCAN_API_KEY。',
            ),
          ),

          h('div', { style: S.divider }),

          h(
            'div',
            null,
            h('div', { style: S.label }, '模型列表'),
            h(
              'div',
              { style: S.list },
              ...allModels.map((m) =>
                h(
                  'div',
                  { key: m.id, style: { ...S.row, alignItems: 'flex-start' } },
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 auto' } },
                    h('span', { style: { color: T.text, fontWeight: 500 } }, m.label),
                    h('span', { style: { ...S.mono, color: T.text3 } }, m.model),
                    h(
                      'span',
                      {
                        style: {
                          ...S.mono,
                          color: T.text3,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                      },
                      m.endpoint,
                    ),
                  ),
                  h('span', { style: S.badge('') }, m.custom ? '自定义' : '预设'),
                  m.custom
                    ? h(
                        'button',
                        { type: 'button', style: S.btn(false, true), onClick: () => removeCustom(m.id) },
                        '删除',
                      )
                    : null,
                ),
              ),
            ),
            h(
              'div',
              { style: { ...S.hint, marginTop: 6 } },
              '「预设」只是预填了模型 ID 和接口地址；Key 仍然由你提供，不会随插件分发。',
            ),
          ),

          h('div', { style: S.divider }),

          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            h('div', { style: { ...S.label, marginBottom: 0, color: T.text2 } }, '添加云端模型'),
            h('div', null, h('div', { style: S.label }, '显示名称'), h('input', {
              style: S.input,
              value: draft.label,
              placeholder: '例如 我的混元',
              onChange: (e) => setDraft({ ...draft, label: e.target.value }),
            })),
            h('div', null, h('div', { style: S.label }, '模型 ID'), h('input', {
              style: S.input,
              value: draft.model,
              placeholder: 'xophunyuanocr',
              onChange: (e) => setDraft({ ...draft, model: e.target.value }),
            })),
            h('div', null, h('div', { style: S.label }, '接口地址（OpenAI 兼容）'), h('input', {
              style: S.input,
              value: draft.endpoint,
              placeholder: 'https://.../v2/chat/completions',
              onChange: (e) => setDraft({ ...draft, endpoint: e.target.value }),
            })),
            h(
              'button',
              { type: 'button', style: S.btn(true), onClick: addCustomModel },
              Icon.plus(14),
              h('span', null, '添加'),
            ),
          ),

          error ? h('div', { style: S.err }, error) : null,
        ),
      );

      // ---------------------------------------------------------- main
      const mainView = h(
        'div',
        backdrop,
        h(
          'div',
          { style: S.panel, onClick: (e) => e.stopPropagation(), onWheel: (e) => e.stopPropagation() },
          h(
            'div',
            { style: S.header },
            h('h3', { style: S.headerTitle }, '扫描件转 Markdown'),
            h(IconButton, { label: '模型设置', onPress: () => setView('settings') }, Icon.gear(16)),
            closeBtn('关闭'),
          ),

          h(
            'div',
            {
              style: S.drop(hot),
              onClick: () => picker.current && picker.current.click(),
              onDragOver: (e) => {
                e.preventDefault();
                setHot(true);
              },
              onDragLeave: () => setHot(false),
              onDrop: (e) => {
                e.preventDefault();
                setHot(false);
                addFiles(e.dataTransfer && e.dataTransfer.files);
              },
            },
            h('span', { style: { color: T.accent } }, Icon.upload(22)),
            h('div', { style: S.dropTitle }, files.length ? `已选 ${files.length} 页，继续添加` : '拖入页面图片'),
            h('div', { style: S.hint }, '或点击选择文件 · Ctrl+V 粘贴'),
          ),

          h('input', {
            ref: picker,
            type: 'file',
            accept: 'image/*',
            multiple: true,
            style: { display: 'none' },
            onChange: (e) => {
              addFiles(e.target.files);
              e.target.value = '';
            },
          }),

          files.length
            ? h(
                'div',
                { style: S.list },
                ...files.map((f, i) =>
                  h(
                    'div',
                    { key: f.name + '-' + i, style: S.row },
                    h(
                      'span',
                      { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      f.name,
                    ),
                    h(
                      'span',
                      { style: { color: T.text3, flex: '0 0 auto' } },
                      Math.round(f.file.size / 1024) + ' KB',
                    ),
                  ),
                ),
              )
            : null,

          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'flex-end' } },
            h(
              'div',
              { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', { style: S.label }, '模型'),
              h(
                'select',
                {
                  style: S.input,
                  value: selected,
                  onChange: (e) => setSelected(e.target.value),
                  disabled: running,
                },
                ...allModels.map((m) => h('option', { key: m.id, value: m.id }, m.label)),
              ),
            ),
            files.length
              ? h(
                  'button',
                  { type: 'button', style: S.btn(false, true), onClick: () => setFiles([]), disabled: running },
                  '清空',
                )
              : null,
          ),

          // PaddleOCR-VL reads tables less reliably than Hunyuan: on a table
          // page it can drop a column header. Say so where the choice is made.
          current && String(current.model).indexOf('paddle') >= 0
            ? h('div', { style: S.hint }, '提示：表格较多的页面用「混元 OCR」识别更准。')
            : null,

          h(
            'div',
            null,
            h('div', { style: S.label }, '书名'),
            h('input', {
              style: S.input,
              value: title,
              onChange: (e) => setTitle(e.target.value),
              disabled: running,
            }),
          ),

          !hasKey
            ? h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: S.err }, '还没有 API Key'),
                h(
                  'button',
                  { type: 'button', style: S.btn(false, true), onClick: () => setView('settings') },
                  '去设置',
                ),
              )
            : null,

          h(
            'button',
            {
              type: 'button',
              style: {
                ...S.btn(true),
                width: '100%',
                opacity: running || !files.length || !hasKey ? 0.55 : 1,
                cursor: running || !files.length || !hasKey ? 'default' : 'pointer',
              },
              onClick: run,
              disabled: running || !files.length || !hasKey,
            },
            running ? `识别中 ${progress.done}/${progress.total}` : '开始识别',
          ),

          running ? h('div', { style: S.progressTrack }, h('div', { style: S.progressFill(pct) })) : null,

          error ? h('div', { style: S.err }, error) : null,

          result
            ? h(
                'div',
                { style: S.card },
                h('div', { style: S.ok }, '已完成'),
                h('div', { style: { ...S.mono, color: T.text3, wordBreak: 'break-all' } }, result.mdPath),
                h(
                  'button',
                  {
                    type: 'button',
                    style: { ...S.btn(false, true), alignSelf: 'flex-start' },
                    onClick: () => navigator.clipboard && navigator.clipboard.writeText(result.mdPath),
                  },
                  '复制路径',
                ),
              )
            : null,
        ),
      );

      return h(
        React.Fragment,
        null,
        dockBar,
        open ? h(Portal, null, view === 'settings' ? settingsView : mainView) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'ocr-scan', order: 30 },
            Panel,
          ),
        );
      },
    };
  },
});
