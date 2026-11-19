/**
 * OCR Scan — host half.
 *
 * Owns everything that must run outside the browser: calling the OCR model,
 * ordering pages, and writing the Markdown plus images to disk. The browser
 * half only drops files and shows progress.
 *
 * Transport: this plugin registers exact webserver routes. The Desktop shell
 * dispatches the same route handlers through its carrier, so the panel works in
 * both the web page and the desktop window.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Schemastery ships with the harness. Resolve it from whichever anchor this
 *  profile offers instead of declaring it, so the bundle needs no install. */
function loadSchema() {
  const anchors = [
    'schemastery',
    '@deepseek-ai/schemastery',
  ];
  for (const id of anchors) {
    try {
      const mod = require(id);
      return mod && mod.default ? mod.default : mod;
    } catch {
      /* try the next anchor */
    }
  }
  return null;
}

const Schema = loadSchema();

export const name = 'ocr-scan';

export const inject = ['webServer'];

export const Config = Schema
  ? Schema.object({
      endpoint: Schema.string()
        .default('https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions')
        .description('OpenAI-compatible chat completions endpoint used for OCR.'),
      model: Schema.string()
        .default('xophunyuanocr')
        .description('Model id sent with each request.'),
      apiKey: Schema.string()
        .default('')
        .description('Bearer token for the endpoint. Leave empty to read OCR_SCAN_API_KEY.'),
      outputDir: Schema.string()
        .default('')
        .description('Directory for generated Markdown and images. Empty writes under the session workspace.'),
    })
  : undefined;

const PRESETS = [
  {
    id: 'hunyuanocr',
    label: '混元 OCR',
    model: 'xophunyuanocr',
    endpoint: 'https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions',
    note: '标题层级自带，稳定不失控',
  },
  {
    id: 'paddleocr',
    label: 'PaddleOCR-VL',
    model: 'xoppaddleocrv16',
    endpoint: 'https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions',
    note: '文字量大，需防表格失控',
  },
  {
    id: 'deepseekocr',
    label: 'DeepSeek-OCR',
    model: 'xopdeepseekocr',
    endpoint: 'https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions',
    note: '原生输出版面标记',
  },
];

const PROMPT =
  'OCR this image. Output plain text only, no markdown tables, no markdown syntax.';

/** In-flight jobs, keyed by job id. Lost on restart, which is fine: the
 *  Markdown on disk is the durable result. */
const jobs = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Read the printed folio from prepared header crops.
 *
 *  Books print it at the left of even pages and the right of odd ones, so the
 *  panel sends both ends. A page number is what makes reading order correct,
 *  because scan order is routinely wrong.
 */
async function readFolioViaModel({ endpoint, apiKey, model, left, right }) {
  const ask = async (imageB64) => {
    if (!imageB64) return null;
    const payload = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'This is a strip cropped from the top of a scanned book page. ' +
                'It may contain the printed page number, usually written like 195 or ·195·. ' +
                'If you see such a number, reply with the digits only. ' +
                'If there is no page number in the strip, reply exactly: none',
            },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 16,
    };
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const raw = String(data?.choices?.[0]?.message?.content ?? '')
        .trim()
        .replace(/[·•∙。.，,\s]/g, '');
      // Only a bare number is a folio. "The number 1", "件", "—" and other
      // header fragments are misreads, not page numbers.
      if (!/^\d{2,4}$/.test(raw)) return null;
      const n = Number(raw);
      return n >= 2 && n <= 2000 ? n : null;
    } catch {
      return null;
    }
  };

  const both = await Promise.all([ask(left), ask(right)]);
  const found = both.filter((n) => Number.isFinite(n));
  if (!found.length) return null;
  // Both ends agreeing is the confident case; when they disagree, prefer the
  // one that looks like a real folio (3-4 digits beats a stray 2-digit read).
  if (found.length === 2 && found[0] !== found[1]) {
    return String(found[0]).length >= String(found[1]).length ? found[0] : found[1];
  }
  return found[0];
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** One OCR call. Returns the text plus a few facts the panel shows. */
async function recognize({ endpoint, apiKey, model, imageB64 }) {
  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 8192,
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`模型返回 ${res.status}：${detail}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? '';
  return {
    text,
    tokens: data?.usage?.completion_tokens ?? null,
  };
}

// ------------------------------------------------------------------ 版面整理
const RE_CHAP = /^第[一二三四五六七八九十百]+章/;
const RE_SECT = /^第[一二三四五六七八九十百]+节/;
const RE_RUNHEAD = /\d{3}\s*[·•∙。]/;
const RE_FIG = /^图\s*([0-9]{1,2})\s*[-–—.·．]?\s*([0-9]{0,3})/;
const RE_TAB = /^表\s*([0-9]{1,2})\s*[-–—.·．]?\s*([0-9]{0,3})/;

function isPageNumberLine(t) {
  const s = t.replace(/[\s·•∙。.、，,]/g, '');
  return /^\d{2,4}$/.test(s);
}

/** Drop running heads, page numbers and continuation marks. */
function stripRunningHead(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) {
      out.push('');
      continue;
    }
    if (isPageNumberLine(t) && t.length <= 8) continue;
    if (RE_RUNHEAD.test(t) && t.length <= 40) continue;
    if (RE_CHAP.test(t) && t.length <= 30 && !/[。，；：]/.test(t)) continue;
    if (t === '(续)' || t === '（续）') continue;
    out.push(raw);
  }
  return out.join('\n');
}

/** The model emits `| a | b |` rows without a delimiter row, which most
 *  Markdown renderers refuse to see as a table. Rebuild them properly. */
/** PaddleOCR sometimes repeats the same caption three times inside one line
 *  (`图9-7 空心轴  图9-7 空心轴  图9-7 空心轴`). Keep the first of each. */
function dedupeCaptions(text) {
  const captionish = (s) => /^图\s*\d|^表\s*\d|^\d+\s*[—–-]\s*\S/.test(s);

  return text
    .split('\n')
    .map((ln) => {
      const units = String(ln).trim().split(/\s{2,}/).filter(Boolean);
      if (units.length < 2 || !captionish(units[0])) return ln;
      const seen = [];
      for (const u of units) if (seen.indexOf(u) === -1) seen.push(u);
      return seen.length < units.length ? seen.join('  ') : ln;
    })
    .join('\n');
}

/** Split a line into table cells, or null when it is not a table row.
 *
 *  Models disagree on whether a table row starts with a pipe: Hunyuan emits
 *  `| a | b |`, PaddleOCR-VL emits `a | b`. Requiring a leading pipe silently
 *  turned every PaddleOCR table into prose, so the test is "has at least two
 *  pipes", and a real table is a run of at least two such lines.
 */
function tableCells(line) {
  const t = String(line || '').trim();
  if (!t) return null;
  if ((t.match(/\|/g) || []).length < 2) return null;
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** `---|---` / `|:--|--:|` — the delimiter row Markdown needs. */
function isDelimiterRow(cells) {
  if (!cells || cells.length < 2) return false;
  let dashes = 0;
  for (const c of cells) {
    if (c === '') continue;
    if (/^:?-{2,}:?$/.test(c)) {
      dashes += 1;
      continue;
    }
    return false;
  }
  return dashes >= 2;
}

/** Rebuild every table as valid Markdown: leading pipes, a delimiter row,
 *  and one column count for all rows. */
function fixMarkdownTables(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const first = tableCells(lines[i]);
    const second = tableCells(lines[i + 1]);
    if (!first || !second) {
      out.push(lines[i]);
      i += 1;
      continue;
    }

    const block = [];
    while (i < lines.length) {
      const cells = tableCells(lines[i]);
      if (!cells) break;
      block.push(cells);
      i += 1;
    }

    const rows = block.filter((cells) => !isDelimiterRow(cells));
    if (!rows.length) continue;

    const width = Math.max(...rows.map((r) => r.length));
    const padded = rows.map((r) => r.concat(Array(width - r.length).fill('')));

    // A short orphan line directly above the table is usually a header fragment
    // the model split off ("弯曲疲劳"), not content.
    let k = out.length - 1;
    while (k >= 0 && !out[k].trim()) k -= 1;
    if (k >= 0) {
      const cand = out[k].trim();
      const orphan =
        cand.length <= 10 &&
        !/[。，；：！？、]/.test(cand) &&
        !cand.startsWith('#') &&
        !cand.startsWith('|') &&
        !cand.startsWith('![') &&
        !/^图\s*\d|^表\s*\d/.test(cand);
      if (orphan) out.splice(k, 1);
    }

    if (out.length && out[out.length - 1].trim()) out.push('');
    out.push(`| ${padded[0].join(' | ')} |`);
    out.push(`|${Array(width).fill(' --- ').join('|')}|`);
    for (const r of padded.slice(1)) out.push(`| ${r.join(' | ')} |`);
    if (i < lines.length && lines[i].trim()) out.push('');
  }
  return out.join('\n');
}

/** Join the short label lines under a figure into one line, and collapse the
 *  runs of blank lines the model leaves behind. */
function tightenBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  const labelish = (s) => /^图\s*\d|^\d+\s*[—–-]\s*\S/.test(s.trim());

  for (const ln of lines) {
    const prev = out.length ? out[out.length - 1] : '';
    if (labelish(ln) && prev && labelish(prev)) {
      out[out.length - 1] = `${prev.trim()}  ${ln.trim()}`;
      continue;
    }
    out.push(ln);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Markdown needs a blank line between blocks, or two lines render as one
 *  paragraph. Keep table rows together and headings attached to nothing. */
function separateBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  for (const ln of lines) {
    const prev = out.length ? out[out.length - 1] : '';
    const isTable = ln.trim().startsWith('|');
    const prevTable = prev.trim().startsWith('|');
    if (
      ln.trim() &&
      prev.trim() &&
      !isTable &&
      !prevTable &&
      !ln.trim().startsWith('#') &&
      !prev.trim().startsWith('#')
    ) {
      out.push('');
    }
    out.push(ln);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function stripFakeImages(text) {
  return text
    .replace(/!\[[^\]]*\]\(https?:\/\/via\.placeholder\.com[^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\(image\.png\)/g, '')
    .replace(/<img\s+src="image\.png"\s*\/?>/g, '');
}

/** Turn one page's raw OCR text into Markdown with stable heading levels. */
function normalizePage(raw, seenHeads) {
  let text = stripFakeImages(stripRunningHead(raw));
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push('');
      continue;
    }
    const hashes = /^(#{1,6})\s/.exec(trimmed);
    if (hashes) {
      let title = trimmed.slice(hashes[1].length).trim();
      // Model often glues the section heading to its first paragraph.
      const split = /^([^。；]{2,24})(.+)$/.exec(title);
      const pieces = [];
      if (!(title.length <= 22 && !/[。；]/.test(title)) && split) {
        pieces.push(split[1].trim());
        title = split[1].trim();
        const rest = split[2].trim();
        if (rest.length >= 4) pieces.push(rest);
      } else {
        pieces.push(title);
      }
      const key = pieces[0].replace(/\s+/g, '');
      let level = '###';
      if (RE_SECT.test(pieces[0]) || RE_CHAP.test(pieces[0])) level = '##';
      else if (/^[一二三四五六七八九十]+、/.test(pieces[0])) level = '###';
      else if (/^[（(]?[0-9一二三四五六七八九十]+[)）.、]\s*\S/.test(pieces[0])) level = '####';
      const ok =
        pieces[0].length >= 4 &&
        /^[\u4e00-\u9fff]/.test(pieces[0]) &&
        (pieces[0].match(/[\u4e00-\u9fff]/g) || []).length >= 4;
      if (ok && !seenHeads.has(key)) {
        seenHeads.add(key);
        out.push(`${level} ${pieces[0]}`);
      }
      for (const extra of pieces.slice(1)) out.push(extra);
      continue;
    }
    out.push(trimmed);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ 页序
/** Pull a printed page number out of the running head.
 *
 *  Books print it in the header, on the left for even pages and the right for
 *  odd ones, as `·195·` or `195`. The OCR text carries it as a short line of
 *  digits, sometimes with a trailing punctuation mark. Scanning order is not
 *  book order — scans are routinely pairwise swapped — so this is the only
 *  reliable key. */
function readFolio(text) {
  const head = String(text || '').slice(0, 400);
  // 页眉最典型：·195·  195。  195
  const bold = /[·•∙]\s*(\d{2,4})\s*[·•∙]/.exec(head);
  if (bold) return Number(bold[1]);
  for (const raw of head.split('\n').slice(0, 4)) {
    const t = raw.replace(/\s+/g, '');
    if (!t) continue;
    let m = /^[·•∙]?(\d{2,4})[·•∙。.]?$/.exec(t);
    if (m) {
      const n = Number(m[1]);
      if (n >= 2 && n <= 2000) return n;
    }
    m = /(\d{3})\s*[。·•∙]/.exec(t);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Reading order. Printed folios are the strongest evidence, then the printed
 * body tells us whether two adjacent pages actually continue each other.
 */
function orderPages(pages) {
  const known = pages.filter((p) => Number.isFinite(p.folio));
  const unknown = pages.filter((p) => !Number.isFinite(p.folio));

  let ordered;
  // Two known folios are already enough to order a small batch; requiring
  // three silently fell back to scan order for short runs.
  const needFolios = Math.max(2, Math.ceil(pages.length * 0.4));
  if (known.length >= needFolios) {
    ordered = known.slice().sort((a, b) => a.folio - b.folio);
    // Unknown folios slot in by scan position relative to their neighbours.
    for (const p of unknown) {
      let at = ordered.findIndex((q) => q.scanIndex > p.scanIndex);
      if (at < 0) at = ordered.length;
      ordered.splice(at, 0, p);
    }
  } else {
    ordered = pages.slice().sort((a, b) => a.scanIndex - b.scanIndex);
  }

  // Continuity pass: a page whose opening repeats the tail of its predecessor
  // and whose body instead continues the page before that is out of place.
  const score = (a, b) => {
    const tail = (a.text || '').slice(-40);
    const head = (b.text || '').slice(0, 40);
    const grams = (s) => {
      const clean = s.replace(/[\s。，、；：（）()【】]/g, '');
      const set = new Set();
      for (let i = 0; i + 1 < clean.length; i += 1) set.add(clean.slice(i, i + 2));
      return set;
    };
    const A = grams(tail);
    const B = grams(head);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const g of A) if (B.has(g)) hit += 1;
    return hit / Math.min(A.size, B.size);
  };

  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 1; i < ordered.length - 1; i += 1) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      const next = ordered[i + 1];
      if (score(prev, cur) > 0.25) continue; // already continues
      if (score(prev, next) > 0.45 && score(prev, next) > score(prev, cur) + 0.2) {
        ordered[i] = next;
        ordered[i + 1] = cur;
      }
    }
  }

  return ordered;
}

// ------------------------------------------------------------------ 输出
function slug(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-|-$/g, '') || 'output';
}

async function writeBook({ pages, title, dir }) {
  const imagesDir = path.join(dir, 'images');
  await mkdir(imagesDir, { recursive: true });

  const seenHeads = new Set();
  const parts = [];
  const index = [];

  for (const p of pages) {
    const imageName = `page-${p.folio ?? p.scanIndex}.jpg`;
    await writeFile(path.join(imagesDir, imageName), Buffer.from(p.imageB64, 'base64'));
    const body = normalizePage(p.text || '', seenHeads);
    const label = p.folio != null ? `p.${p.folio}` : `#${p.scanIndex}`;
    parts.push(`<!-- ${label} -->\n\n![[images/${imageName}]]\n\n${body}`);
    index.push({ page: label, image: imageName });
  }

  let md = parts.join('\n\n');
  md = separateBlocks(tightenBlocks(fixMarkdownTables(dedupeCaptions(md))));
  if (title) md = `# ${title}\n\n${md}`;

  const mdName = `${slug(title || 'ocr-scan')}.md`;
  const mdPath = path.join(dir, mdName);
  await writeFile(mdPath, md, 'utf8');

  const gallery = [
    `# ${title || '扫描页'} · 原书图册`,
    '',
    '按书页顺序排列，点开可看原版插图、表格与公式。',
    '',
    ...index.flatMap((it) => [`## ${it.page}`, '', `![[images/${it.image}]]`, '']),
  ].join('\n');
  await writeFile(path.join(dir, '原书页-图册.md'), gallery, 'utf8');

  return { mdPath, dir, mdName };
}

// ------------------------------------------------------------------ 路由
function resolveDir(config, sessionWorkspace) {
  if (config.outputDir && config.outputDir.trim()) return config.outputDir.trim();
  const base = sessionWorkspace || process.cwd();
  return path.join(base, 'ocr-scan');
}

export function apply(ctx, config) {
  const cfg = config || {};
  const apiKey = () => (cfg.apiKey || process.env.OCR_SCAN_API_KEY || '').trim();

  /** POST /plugins/ocr-scan/run — start a job, return its id. */
  const start = async (req, res) => {
    try {
      const body = await readJson(req);
      const pages = Array.isArray(body.pages) ? body.pages : [];
      if (!pages.length) return json(res, 400, { error: '没有收到页面' });
      const reqKey = String(body.apiKey || '').trim();
      const useKey = reqKey || apiKey();
      if (!useKey) return json(res, 400, { error: '没有配置 API Key' });

      const endpoint = (body.endpoint || cfg.endpoint || PRESETS[0].endpoint).trim();
      const model = (body.model || cfg.model || PRESETS[0].model).trim();
      const dir = resolveDir({ ...cfg, outputDir: body.outputDir ?? cfg.outputDir },
        body.workspace);

      const id = randomUUID();
      const job = {
        id,
        total: pages.length,
        done: 0,
        state: 'running',
        results: [],
        error: null,
        output: null,
      };
      jobs.set(id, job);

      (async () => {
        try {
          const collected = [];
          for (let i = 0; i < pages.length; i += 1) {
            const p = pages[i];
            try {
              const r = await recognize({
                endpoint,
                apiKey: useKey,
                model,
                imageB64: p.imageB64,
              });
              const detected =
                (await readFolioViaModel({
                  endpoint,
                  apiKey: useKey,
                  model,
                  left: p.headLeft,
                  right: p.headRight,
                })) ?? readFolio(r.text);
              collected.push({
                scanIndex: i + 1,
                folio: detected ?? (Number.isFinite(p.folio) ? p.folio : null),
                text: r.text,
                imageB64: p.imageB64,
                tokens: r.tokens,
              });
            } catch (err) {
              collected.push({
                scanIndex: i + 1,
                folio: Number.isFinite(p.folio) ? p.folio : null,
                text: '',
                imageB64: p.imageB64,
                error: String(err.message || err),
              });
            }
            job.done = i + 1;
            job.results.push({ page: i + 1, ok: !collected[i].error });
          }

          const ordered = orderPages(collected);
          job.output = await writeBook({
            pages: ordered,
            title: body.title || '扫描文档',
            dir,
          });
          job.state = 'done';
        } catch (err) {
          job.state = 'failed';
          job.error = String(err.message || err);
        }
      })();

      return json(res, 200, { id, total: pages.length });
    } catch (err) {
      return json(res, 500, { error: String(err.message || err) });
    }
  };

  /** GET /plugins/ocr-scan/jobs/:id — progress and result. */
  const poll = async (req, res, id) => {
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: '任务不存在' });
    return json(res, 200, {
      id: job.id,
      state: job.state,
      total: job.total,
      done: job.done,
      error: job.error,
      output: job.output,
    });
  };

  /** GET /plugins/ocr-scan/presets — models offered in the panel. */
  const presets = async (req, res) =>
    json(res, 200, {
      presets: PRESETS,
      defaultEndpoint: cfg.endpoint || PRESETS[0].endpoint,
      hasKey: Boolean(apiKey()),
    });

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/ocr-scan/run',
      handler: start,
    }),
  );
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/ocr-scan/presets',
      handler: presets,
    }),
  );
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/ocr-scan/status',
      handler: (req, res) => {
        const q = String(req.url || '').split('?')[1] || '';
        const id = new URLSearchParams(q).get('id') || '';
        return poll(req, res, id);
      },
    }),
  );
}

