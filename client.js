/**
 * OCR Scan — browser half.
 *
 * A panel that takes dropped or pasted page images, sends them to the host
 * half one page at a time, and shows progress. All heavy work, including
 * ordering and file writing, happens on the host.
 */
window.__ModuleLoader__.load({
  id: '@local/ocr-scan',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useCallback, useEffect } = React;

    const API = '/plugins/ocr-scan';

    /** Read a page-number cell from the top strip of an image.
     *  Cheap client-side guess; the host re-reads folios if it needs to. */
    function guessFolio() {
      return null;
    }

    function toBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const s = String(reader.result || '');
          resolve(s.slice(s.indexOf(',') + 1));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
    }

    /** Crop the two ends of the running head and scale them up.
     *  The host asks the model about these separately, because a page number
     *  is the only reliable key for reading order and the main OCR text often
     *  drops it. */
    function headerStrips(img) {
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const y0 = Math.round(H * 0.012);
      const h = Math.round(H * 0.078);
      const make = (x) => {
        const w = Math.round(W * 0.3);
        const c = document.createElement('canvas');
        c.width = Math.min(w * 3, 1600);
        c.height = Math.min(h * 3, 480);
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, x, y0, w, h, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.9).split(',')[1];
      };
      return { left: make(0), right: make(Math.round(W * 0.7)) };
    }

    function loadImage(dataUrl) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = dataUrl;
      });
    }

    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
    }

    function naturalKey(name) {
      const m = String(name).match(/\((\d+)\)/);
      return m ? [0, Number(m[1])] : [1, 0];
    }

    const S = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 12,
        maxHeight: '60vh',
        overflow: 'auto',
        color: 'var(--dsw-alias-text, #1b1b1b)',
        background: 'var(--dsw-alias-bg, #fff)',
        fontSize: 13,
        fontFamily: 'inherit',
      },
      head: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        paddingBottom: 8,
        borderBottom: '1px solid var(--dsw-alias-border, #e2e4e8)',
      },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      sub: { fontSize: 12, color: 'var(--dsw-alias-text-muted, #737373)' },
      drop: (hot) => ({
        border: `1.5px dashed ${hot ? 'var(--dsw-alias-accent, #2f5bd7)' : 'var(--dsw-alias-border, #d6d9de)'}`,
        background: hot ? 'var(--dsw-alias-bg-hover, #eef2fe)' : 'var(--dsw-alias-bg-muted, #fafbfc)',
        borderRadius: 8,
        padding: '20px 16px',
        textAlign: 'center',
        cursor: 'pointer',
        transition: 'border-color .15s, background .15s',
      }),
      btn: (primary) => ({
        appearance: 'none',
        border: `1px solid ${primary ? 'var(--dsw-alias-accent, #2f5bd7)' : 'var(--dsw-alias-border, #d6d9de)'}`,
        background: primary ? 'var(--dsw-alias-accent, #2f5bd7)' : 'transparent',
        color: primary ? '#fff' : 'var(--dsw-alias-text, #1b1b1b)',
        font: 'inherit',
        fontSize: 12,
        padding: '5px 12px',
        borderRadius: 6,
        cursor: 'pointer',
      }),
      field: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontSize: 12,
        color: 'var(--dsw-alias-text-muted, #737373)',
      },
      input: {
        font: 'inherit',
        fontSize: 12,
        padding: '5px 8px',
        border: '1px solid var(--dsw-alias-border, #d6d9de)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg, #fff)',
        color: 'var(--dsw-alias-text, #1b1b1b)',
        outline: 'none',
      },
      bar: {
        height: 6,
        borderRadius: 3,
        background: 'var(--dsw-alias-bg-muted, #eef0f3)',
        overflow: 'hidden',
      },
      fill: (pct) => ({
        height: '100%',
        width: `${pct}%`,
        background: 'var(--dsw-alias-accent, #2f5bd7)',
        transition: 'width .2s',
      }),
      list: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 },
      row: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
        padding: '3px 0',
        borderBottom: '1px solid var(--dsw-alias-border-subtle, #f0f1f3)',
      },
      ok: { color: 'var(--dsw-alias-success, #1a7f37)' },
      err: { color: 'var(--dsw-alias-danger, #b42318)' },
      note: {
        fontSize: 11.5,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-text-muted, #737373)',
      },
    };

    function Panel() {
      const [open, setOpen] = useState(false);
      const [files, setFiles] = useState([]);
      const [hot, setHot] = useState(false);
      const [running, setRunning] = useState(false);
      const [progress, setProgress] = useState({ done: 0, total: 0 });
      const [result, setResult] = useState(null);
      const [error, setError] = useState('');
      const [presets, setPresets] = useState([]);
      const [model, setModel] = useState('');
      const [endpoint, setEndpoint] = useState('');
      const [title, setTitle] = useState('扫描文档');
      const [hasKey, setHasKey] = useState(true);
      const [apiKey, setApiKey] = useState('');
      const input = useRef(null);

      useEffect(() => {
        let alive = true;
        fetch(`${API}/presets`)
          .then((r) => r.json())
          .then((d) => {
            if (!alive) return;
            setPresets(d.presets || []);
            if (d.presets && d.presets.length) setModel(d.presets[0].model);
            setEndpoint(d.defaultEndpoint || '');
            setHasKey(Boolean(d.hasKey));
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      const addFiles = useCallback(async (fileList) => {
        const picked = Array.from(fileList || []).filter((f) =>
          /^image\//.test(f.type) || /\.(jpe?g|png|webp|bmp)$/i.test(f.name),
        );
        if (!picked.length) return;
        picked.sort((a, b) => {
          const ka = naturalKey(a.name);
          const kb = naturalKey(b.name);
          return ka[0] - kb[0] || ka[1] - kb[1];
        });
        const next = [];
        for (const f of picked) {
          next.push({ file: f, name: f.name, url: await readAsDataUrl(f) });
        }
        setFiles((prev) => prev.concat(next));
        setError('');
      }, []);

      useEffect(() => {
        const onPaste = (e) => {
          const items = e.clipboardData && e.clipboardData.items;
          if (!items) return;
          const imgs = [];
          for (const it of items) {
            if (it.type && it.type.startsWith('image/')) {
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
        setRunning(true);
        setResult(null);
        setError('');
        setProgress({ done: 0, total: files.length });
        try {
          const pages = [];
          for (let i = 0; i < files.length; i += 1) {
            const strips = headerStrips(await loadImage(files[i].url));
            pages.push({
              imageB64: await toBase64(files[i].file),
              headLeft: strips.left,
              headRight: strips.right,
              folio: guessFolio(),
              name: files[i].name,
            });
          }
          const started = await fetch(`${API}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pages, model, endpoint, title, apiKey }),
          });
          const data = await started.json();
          if (!started.ok) throw new Error(data.error || '启动失败');

          // Poll until the host reports a terminal state.
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

      const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

      // Collapsed by default: this sits in the composer dock, so it must not
      // push the chat around. The bar still shows live progress.
      if (!open) {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              margin: '4px 0',
              border: '1px solid var(--dsw-alias-border, #e2e4e8)',
              borderRadius: 8,
              background: 'var(--dsw-alias-bg-muted, #fafbfc)',
              fontSize: 12,
              color: 'var(--dsw-alias-text-muted, #737373)',
              cursor: 'pointer',
              userSelect: 'none',
            },
            onClick: () => setOpen(true),
            role: 'button',
            tabIndex: 0,
            onKeyDown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') setOpen(true);
            },
          },
          h('span', { style: { fontSize: 13 } }, '⇪'),
          h('span', { style: { color: 'var(--dsw-alias-text, #1b1b1b)', fontWeight: 500 } }, '扫描件转 Markdown'),
          running
            ? h('span', null, `${progress.done}/${progress.total} · ${pct}%`)
            : h('span', null, result ? '已完成，点击查看' : '拖入图片生成 md'),
          running ? h('span', { style: { ...S.bar, width: 90 } }, h('div', { style: S.fill(pct) })) : null,
        );
      }

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.head },
          h('h2', { style: S.title }, '扫描件转 Markdown'),
          h(
            'button',
            {
              type: 'button',
              style: S.btn(false),
              onClick: () => setOpen(false),
              title: '收起',
            },
            '收起',
          ),
        ),

        h(
          'div',
          {
            style: S.drop(hot),
            onClick: () => input.current && input.current.click(),
            onDragOver: (e) => {
              e.preventDefault();
              setHot(true);
            },
            onDragLeave: () => setHot(false),
            onDrop: (e) => {
              e.preventDefault();
              setHot(false);
              addFiles(e.dataTransfer?.files);
            },
          },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '拖入页面图片'),
          h(
            'div',
            { style: S.note },
            '识别后自动排页序、清理页眉、修表格、生成 Markdown 和 images 目录',
          ),
        ),

        h('input', {
          ref: input,
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
              h(
                'div',
                { style: { ...S.row, fontWeight: 600 } },
                h('span', null, `已选 ${files.length} 页`),
                h(
                  'button',
                  {
                    type: 'button',
                    style: S.btn(false),
                    onClick: () => setFiles([]),
                    disabled: running,
                  },
                  '清空',
                ),
              ),
              ...files.slice(0, 8).map((f, i) =>
                h(
                  'div',
                  { key: `${f.name}-${i}`, style: S.row },
                  h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
                  h('span', null, `${(f.file.size / 1024).toFixed(0)} KB`),
                ),
              ),
              files.length > 8
                ? h('div', { style: S.note }, `…另有 ${files.length - 8} 页`)
                : null,
            )
          : null,

        h(
          'div',
          { style: S.field },
          h('span', null, '书名（作为一级标题）'),
          h('input', {
            style: S.input,
            value: title,
            onChange: (e) => setTitle(e.target.value),
            disabled: running,
          }),
        ),

        h(
          'div',
          { style: S.field },
          h('span', null, '模型'),
          h(
            'select',
            {
              style: S.input,
              value: model,
              onChange: (e) => {
                const next = e.target.value;
                setModel(next);
                const p = presets.find((x) => x.model === next);
                if (p) setEndpoint(p.endpoint);
              },
              disabled: running,
            },
            ...presets.map((p) => h('option', { key: p.id, value: p.model }, `${p.label}（${p.model}）`)),
            presets.some((p) => p.model === model)
              ? null
              : h('option', { value: model }, model || '自定义'),
          ),
        ),

        h(
          'div',
          { style: S.field },
          h('span', null, '接口地址（OpenAI 兼容）'),
          h('input', {
            style: S.input,
            value: endpoint,
            onChange: (e) => setEndpoint(e.target.value),
            disabled: running,
          }),
        ),

        h(
          'div',
          { style: S.field },
          h('span', null, 'API Key'),
          h('input', {
            style: S.input,
            type: 'password',
            value: apiKey,
            placeholder: hasKey ? '已配置（留空则用插件设置里的）' : 'ak-...',
            onChange: (e) => setApiKey(e.target.value),
            disabled: running,
          }),
        ),

        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h(
            'button',
            {
              type: 'button',
              style: S.btn(true),
              onClick: run,
              disabled: running || !files.length || (!hasKey && !apiKey),
            },
            running ? `识别中 ${progress.done}/${progress.total}` : '开始识别',
          ),
          running ? h('span', { style: S.note }, `${pct}%`) : null,
        ),

        running || progress.total
          ? h('div', { style: S.bar }, h('div', { style: S.fill(pct) }))
          : null,

        error ? h('div', { style: { ...S.note, ...S.err } }, error) : null,

        result
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { ...S.note, ...S.ok } }, '已完成'),
              h('div', { style: S.note }, `输出目录：${result.dir}`),
              h('div', { style: S.note }, `Markdown：${result.mdName}`),
              h(
                'button',
                {
                  type: 'button',
                  style: S.btn(false),
                  onClick: () => navigator.clipboard?.writeText(result.mdPath),
                },
                '复制文件路径',
              ),
            )
          : null,
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
