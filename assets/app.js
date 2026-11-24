'use strict';

/* ============================================================
   Catatan — aplikasi catatan offline
   ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const now = () => Date.now();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const DEFAULT_NOTEBOOK = 'Umum';
const ls = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

function escapeHtml(text = '') {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Kemarin';
  if (d.getFullYear() === today.getFullYear()) {
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: '2-digit' });
}

function fmtFull(ts) {
  return new Date(ts).toLocaleString('id-ID', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function escapeRegExp(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function two(value) {
  return value < 10 ? `0${value}` : String(value);
}

function dayKey(ts = now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function startOfDay(ts = now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function countWords(text = '') {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function plural(n, word) {
  return `${n} ${word}`;
}

/* ---------------- state ---------------- */

const state = {
  notes: [],
  view: 'all',        // all | fav | tasks | archive | trash
  query: '',
  tag: null,
  notebook: null,
  sort: ls.get('catatan.sort') || 'updated',
  currentId: ls.get('catatan.last') || null,
  mode: ls.get('catatan.mode') || 'write',   // write | split | preview
  focus: false,
  paletteIndex: 0,
  paletteItems: [],
};

let pendingNote = null;
let saveTimer = null;
let syncFrame = null;
let toastTimer = null;
let deferredInstallPrompt = null;
let sheetAction = null;
let printCleanupTimer = null;

const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH_DAYS = 30;
const HISTORY_LIMIT = 20;
const HISTORY_GAP = 90 * 1000;

const MODE_LABELS = { write: 'Tulis', split: 'Pisah', preview: 'Pratinjau' };
const MODE_ORDER = ['write', 'split', 'preview'];

/* ---------------- storage ---------------- */

const Store = {
  db: null,
  mode: 'idb',

  async init() {
    if (!('indexedDB' in window)) {
      this.mode = 'local';
      this.loadLocal();
      return;
    }
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('catatan-db', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('notes')) {
            const store = db.createObjectStore('notes', { keyPath: 'id' });
            store.createIndex('updatedAt', 'updatedAt');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('Database diblokir'));
      });
      state.notes = await new Promise((resolve, reject) => {
        const tx = this.db.transaction('notes', 'readonly');
        const req = tx.objectStore('notes').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      this.mode = 'idb';
    } catch (err) {
      console.warn('IndexedDB tidak tersedia, memakai localStorage.', err);
      this.mode = 'local';
      this.db = null;
      this.loadLocal();
    }
  },

  loadLocal() {
    try {
      const data = JSON.parse(localStorage.getItem('catatan.notes') || '[]');
      state.notes = Array.isArray(data) ? data : [];
    } catch {
      state.notes = [];
    }
  },

  saveLocal() {
    try {
      localStorage.setItem('catatan.notes', JSON.stringify(state.notes));
    } catch (err) {
      console.warn(err);
      toast('Penyimpanan penuh — coba ekspor lalu hapus catatan lama.');
    }
  },

  async put(note) {
    if (this.mode === 'idb' && this.db) {
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction('notes', 'readwrite');
          tx.objectStore('notes').put(note);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        return;
      } catch (err) {
        console.warn('Gagal menyimpan ke IndexedDB.', err);
      }
    }
    this.saveLocal();
  },

  async remove(id) {
    if (this.mode === 'idb' && this.db) {
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction('notes', 'readwrite');
          tx.objectStore('notes').delete(id);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        return;
      } catch (err) {
        console.warn('Gagal menghapus dari IndexedDB.', err);
      }
    }
    this.saveLocal();
  },

  async removeMany(ids) {
    if (this.mode === 'idb' && this.db) {
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction('notes', 'readwrite');
          const store = tx.objectStore('notes');
          ids.forEach((id) => store.delete(id));
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        return;
      } catch (err) {
        console.warn('Gagal mengosongkan IndexedDB.', err);
      }
    }
    this.saveLocal();
  },
};

/* ---------------- markdown ---------------- */

function inlineMd(text = '') {
  const tokens = [];
  const token = (html) => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };

  // Kode inline dilindungi lebih dulu agar isinya tidak diformat ulang.
  let out = text.replace(/`([^`\n]+)`/g, (_m, code) => token(`<code>${code}</code>`));
  // Wikilink [[Judul catatan]] — tautan internal antar catatan.
  out = out.replace(/\[\[([^\]\n]{1,120})\]\]/g, (_m, label) => {
    const name = label.trim();
    return token(`<a href="#" class="wikilink" data-wikilink="${name}">${name}</a>`);
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const safe = /^(https?:|mailto:|\/|\.|#)/i.test(url) ? url : '#';
    return token(`<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });
  out = out.replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]}])/g, (url) =>
    token(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  out = out.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => tokens[Number(i)] || '');
  return out;
}

function renderMarkdown(md = '') {
  if (!md.trim()) return '';
  const lines = escapeHtml(md).replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let list = null;      // 'ul' | 'ol'
  let taskList = false;
  let para = [];

  const closeList = () => {
    if (list) { html += `</${list}>`; list = null; taskList = false; }
  };
  const flush = () => {
    if (para.length) {
      html += `<p>${inlineMd(para.join('\n')).replace(/\n/g, '<br>')}</p>`;
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      flush(); closeList();
      let code = '';
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code += lines[i] + '\n';
        i++;
      }
      html += `<pre><code>${code.replace(/\n$/, '')}</code></pre>`;
      continue;
    }

    if (!trimmed) { flush(); closeList(); continue; }

    if (/^(---+|\*\*\*+|___+)$/.test(trimmed)) {
      flush(); closeList(); html += '<hr>'; continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush(); closeList();
      const level = heading[1].length;
      html += `<h${level}>${inlineMd(heading[2].trim())}</h${level}>`;
      continue;
    }

    // Tabel GFM sederhana.
    const isTableSep = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test((lines[i + 1] || '').trim());
    if (trimmed.includes('|') && isTableSep) {
      flush(); closeList();
      const parseRow = (row) => row.trim()
        .replace(/^\|/, '').replace(/\|$/, '')
        .split('|').map((cell) => cell.trim());
      const headers = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      i--;
      const head = headers.map((cell) => `<th>${inlineMd(cell)}</th>`).join('');
      const body = rows.map((row) => `<tr>${headers
        .map((_h, c) => `<td>${inlineMd(row[c] || '')}</td>`).join('')}</tr>`).join('');
      html += `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
      continue;
    }

    if (/^(?:>|&gt;)\s?/.test(trimmed)) {
      flush(); closeList();
      const quote = [];
      while (i < lines.length && /^(?:>|&gt;)\s?/.test(lines[i].trim())) {
        quote.push(lines[i].replace(/^\s*(?:>|&gt;)\s?/, ''));
        i++;
      }
      i--;
      const callout = quote[0] && quote[0].match(/^\[!(note|tip|warn|warning|danger|important)\]\s*(.*)$/i);
      if (callout) {
        const rawKind = callout[1].toLowerCase();
        const kind = rawKind === 'warning' || rawKind === 'important' ? 'warn' : rawKind;
        const labels = { note: 'Catatan', tip: 'Tips', warn: 'Peringatan', danger: 'Bahaya' };
        const title = callout[2] ? ` · ${inlineMd(callout[2])}` : '';
        const rest = quote.slice(1);
        html += `<blockquote class="callout callout-${kind}">` +
          `<div class="callout-title">${labels[kind] || 'Catatan'}${title}</div>` +
          `${rest.length ? inlineMd(rest.join('\n')).replace(/\n/g, '<br>') : ''}</blockquote>`;
      } else {
        html += `<blockquote>${inlineMd(quote.join('\n')).replace(/\n/g, '<br>')}</blockquote>`;
      }
      continue;
    }

    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      flush();
      if (!list || !taskList) {
        closeList();
        html += '<ul class="task-list">';
        list = 'ul';
        taskList = true;
      }
      const done = task[1].toLowerCase() === 'x';
      html += `<li class="task${done ? ' done' : ''}">` +
        `<input type="checkbox" data-line="${i}" ${done ? 'checked' : ''} aria-label="Tandai tugas">` +
        `<span>${inlineMd(task[2])}</span></li>`;
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flush();
      if (!list || taskList) {
        closeList();
        html += '<ul>';
        list = 'ul';
      }
      html += `<li>${inlineMd(bullet[1])}</li>`;
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flush();
      if (!list || taskList) {
        closeList();
        html += '<ol>';
        list = 'ol';
      }
      html += `<li>${inlineMd(ordered[1])}</li>`;
      continue;
    }

    closeList();
    para.push(line);
  }

  flush(); closeList();
  return html;
}

/* ---------------- note helpers ---------------- */

function currentNote() {
  return state.notes.find((n) => n.id === state.currentId) || null;
}

function displayTitle(note) {
  const title = (note.title || '').trim();
  if (title) return title;
  const first = (note.body || '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!first) return 'Catatan tanpa judul';
  const cleaned = first
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+(\[[ xX]\]\s*)?/, '')
    .replace(/^>\s?/, '')
    .replace(/[*_`~]/g, '')
    .trim();
  return cleaned.slice(0, 70) || 'Catatan tanpa judul';
}

function snippet(note) {
  return (note.body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s*)?/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_`~=]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function taskStats(note) {
  let total = 0;
  let done = 0;
  for (const line of (note.body || '').split('\n')) {
    const match = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+/);
    if (match) {
      total++;
      if (match[1].toLowerCase() === 'x') done++;
    }
  }
  return { total, done };
}

function collectTasks(notes) {
  const out = [];
  for (const note of notes) {
    (note.body || '').split('\n').forEach((line, index) => {
      const match = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
      if (!match) return;
      out.push({
        note,
        line: index,
        done: match[1].toLowerCase() === 'x',
        text: match[2].replace(/[*_`]/g, '').trim(),
      });
    });
  }
  return out;
}

/* ---------------- wikilink + riwayat ---------------- */

function titleKey(text = '') {
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ');
}

function findNoteByTitle(title) {
  const key = titleKey(title);
  if (!key) return null;
  return state.notes.find((n) => !n.deleted && titleKey(displayTitle(n)) === key) || null;
}

function wikilinksIn(note) {
  const out = [];
  const seen = new Set();
  const re = /\[\[([^\]\n]{1,120})\]\]/g;
  let match;
  while ((match = re.exec(note.body || ''))) {
    const name = match[1].trim();
    const key = titleKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function notesLinkingTo(note) {
  const key = titleKey(displayTitle(note));
  if (!key) return [];
  return state.notes.filter((n) => {
    if (n.deleted || n.id === note.id) return false;
    return wikilinksIn(n).some((link) => titleKey(link) === key);
  });
}

function pushHistory(note, force = false) {
  if (!note || note.deleted || !(note.body || '').trim()) return false;
  const versions = Array.isArray(note.versions) ? note.versions : (note.versions = []);
  const last = versions[0];
  if (last && last.body === note.body && last.title === note.title) return false;
  if (!force && last && now() - last.at < HISTORY_GAP) return false;

  versions.unshift({
    id: uid(),
    at: now(),
    title: note.title || '',
    body: note.body || '',
  });
  if (versions.length > HISTORY_LIMIT) versions.length = HISTORY_LIMIT;
  return true;
}

function sanitizeVersions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v) => v && typeof v === 'object')
    .slice(0, HISTORY_LIMIT)
    .map((v) => ({
      id: typeof v.id === 'string' && v.id ? v.id : uid(),
      at: Number.isFinite(v.at) ? v.at : now(),
      title: typeof v.title === 'string' ? v.title : '',
      body: typeof v.body === 'string' ? v.body : '',
    }));
}

/* ---------------- filtering + sorting ---------------- */

function notesInView() {
  let arr;
  if (state.view === 'trash') {
    arr = state.notes.filter((n) => n.deleted);
  } else if (state.view === 'archive') {
    arr = state.notes.filter((n) => n.archived && !n.deleted);
  } else {
    arr = state.notes.filter((n) => !n.deleted && !n.archived);
    if (state.view === 'fav') arr = arr.filter((n) => n.pinned);
  }

  const query = state.query.trim().toLowerCase();
  if (state.notebook) {
    arr = arr.filter((n) => (n.notebook || DEFAULT_NOTEBOOK) === state.notebook);
  }
  if (state.tag) {
    arr = arr.filter((n) => (n.tags || []).includes(state.tag));
  }
  if (query) {
    arr = arr.filter((n) => {
      const haystack = `${n.title || ''} ${n.body || ''} ${(n.tags || []).join(' ')} ${n.notebook || ''}`;
      return haystack.toLowerCase().includes(query);
    });
  }
  return arr;
}

function sortNotes(arr) {
  const compare = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    title: (a, b) => displayTitle(a).localeCompare(displayTitle(b), 'id'),
  }[state.sort] || ((a, b) => b.updatedAt - a.updatedAt);

  return arr.sort((a, b) => {
    if (state.view !== 'trash') {
      const pin = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      if (pin) return pin;
    }
    return compare(a, b);
  });
}

/* ---------------- render: list ---------------- */

const VIEW_TITLES = {
  all: 'Semua catatan',
  fav: 'Disematkan',
  tasks: 'Tugas',
  archive: 'Arsip',
  trash: 'Sampah',
};

function noteItemHTML(note) {
  const active = note.id === state.currentId ? ' active' : '';
  const archived = note.archived ? ' archived' : '';
  const stats = taskStats(note);
  const text = snippet(note);
  const tags = (note.tags || []).slice(0, 3)
    .map((tag) => `<span class="mini-tag">#${escapeHtml(tag)}</span>`)
    .join('');

  return `<button class="note-item${active}${archived}" data-id="${note.id}" role="listitem">
    <div class="note-item-top">
      <h3>${escapeHtml(displayTitle(note))}</h3>
      ${note.pinned ? '<span class="pin" title="Disematkan"><svg class="icon"><use href="#i-pin"/></svg></span>' : ''}
      ${stats.total ? `<span class="progress-pill${stats.done === stats.total ? ' done' : ''}">✓ ${stats.done}/${stats.total}</span>` : ''}
    </div>
    ${text ? `<p class="snippet">${escapeHtml(text)}</p>` : ''}
    <div class="note-item-foot">
      <time datetime="${new Date(note.updatedAt).toISOString()}">${fmtDate(note.updatedAt)}</time>
      <span class="mini-tags">${tags}</span>
    </div>
  </button>`;
}

function taskHTML(task) {
  const meta = `${displayTitle(task.note)}${task.note.notebook ? ` · ${task.note.notebook}` : ''}`;
  return `<div class="task-row${task.done ? ' done' : ''}" data-note="${task.note.id}" data-line="${task.line}" role="listitem">
    <input type="checkbox" class="task-check" ${task.done ? 'checked' : ''} aria-label="${escapeHtml(task.text)}">
    <div class="task-main">
      <span class="task-text">${escapeHtml(task.text)}</span>
      <span class="task-meta">${escapeHtml(meta)}</span>
    </div>
  </div>`;
}

function emptyListHTML() {
  if (state.query) {
    return `<div class="list-empty">
      <svg class="icon"><use href="#i-search"/></svg>
      <p>Tidak ada catatan yang cocok dengan<br><strong>“${escapeHtml(state.query)}”</strong></p>
    </div>`;
  }
  if (state.view === 'trash') {
    return `<div class="list-empty">
      <svg class="icon"><use href="#i-trash"/></svg>
      <p>Sampah kosong.</p>
    </div>`;
  }
  if (state.view === 'archive') {
    return `<div class="list-empty">
      <svg class="icon"><use href="#i-archive"/></svg>
      <p>Belum ada catatan yang diarsipkan.</p>
    </div>`;
  }
  if (state.view === 'fav') {
    return `<div class="list-empty">
      <svg class="icon"><use href="#i-star"/></svg>
      <p>Sematkan catatan penting dengan ikon pin di editor.</p>
    </div>`;
  }
  if (state.view === 'tasks') {
    return `<div class="list-empty">
      <svg class="icon"><use href="#i-check"/></svg>
      <p>Belum ada tugas.<br>Tulis <code>- [ ] tugasmu</code> di catatan.</p>
    </div>`;
  }
  return `<div class="list-empty">
    <svg class="icon"><use href="#i-note"/></svg>
    <p>Belum ada catatan di sini.</p>
    <button class="primary-btn" data-action="new"><svg class="icon"><use href="#i-plus"/></svg> Mulai menulis</button>
  </div>`;
}

function renderList() {
  const list = $('#noteList');
  $('#listTitle').textContent = VIEW_TITLES[state.view] || 'Catatan';
  $('#emptyTrashBtn').hidden = state.view !== 'trash' || !state.notes.some((n) => n.deleted);
  $('#emptyTrashBtn').title = `Catatan di sampah otomatis dihapus setelah ${TRASH_DAYS} hari`;

  const notes = sortNotes(notesInView());

  if (state.view === 'tasks') {
    renderTasks(notes);
    return;
  }

  $('#listCount').textContent = notes.length;
  list.innerHTML = notes.length ? notes.map(noteItemHTML).join('') : emptyListHTML();
}

function renderTasks(notes) {
  const list = $('#noteList');
  const tasks = collectTasks(notes);
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  $('#listCount').textContent = `${open.length}/${tasks.length}`;

  if (!tasks.length) {
    list.innerHTML = emptyListHTML();
    return;
  }

  let html = '';
  if (open.length) {
    html += `<div class="task-group-head">Belum selesai · ${open.length}</div>`;
    html += open.map(taskHTML).join('');
  }
  if (done.length) {
    html += `<div class="task-group-head">Selesai · ${done.length}</div>`;
    html += done.map(taskHTML).join('');
  }
  list.innerHTML = html;
}

/* ---------------- render: sidebar ---------------- */

function renderSidebar() {
  const active = state.notes.filter((n) => !n.deleted && !n.archived);
  $('#countAll').textContent = active.length;
  $('#countFav').textContent = active.filter((n) => n.pinned).length;
  $('#countTasks').textContent = active.reduce((sum, n) => sum + (taskStats(n).total - taskStats(n).done), 0);
  $('#countArchive').textContent = state.notes.filter((n) => n.archived && !n.deleted).length;
  $('#countTrash').textContent = state.notes.filter((n) => n.deleted).length;

  $$('#sideNav .side-item').forEach((btn) => {
    btn.classList.toggle('active', !state.tag && !state.notebook && btn.dataset.view === state.view);
  });

  renderNotebooks();
  renderTags();
  renderStorageNote();
}

function renderNotebooks() {
  const counts = new Map();
  for (const note of state.notes) {
    if (note.deleted || note.archived) continue;
    const name = note.notebook || DEFAULT_NOTEBOOK;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if (!counts.has(DEFAULT_NOTEBOOK)) counts.set(DEFAULT_NOTEBOOK, 0);

  const names = [...counts.keys()].sort((a, b) => {
    if (a === DEFAULT_NOTEBOOK) return -1;
    if (b === DEFAULT_NOTEBOOK) return 1;
    return a.localeCompare(b, 'id');
  });

  $('#notebookList').innerHTML = names.map((name) => `
    <button class="side-item${state.notebook === name ? ' active' : ''}" data-notebook="${escapeHtml(name)}">
      <svg class="icon"><use href="#i-book"/></svg>
      <span>${escapeHtml(name)}</span>
      <span class="count">${counts.get(name)}</span>
    </button>`).join('');

  $('#notebookOptions').innerHTML = names
    .map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
}

function renderTags() {
  const counts = new Map();
  for (const note of state.notes) {
    if (note.deleted || note.archived) continue;
    for (const tag of note.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  const tags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'id'))
    .slice(0, 24);

  $('#tagList').innerHTML = tags.length
    ? tags.map(([tag, count]) => `<button class="chip${state.tag === tag ? ' active' : ''}" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} <span style="opacity:.6">${count}</span></button>`).join('')
    : '<span class="side-empty">Belum ada tag.</span>';
}

function renderStorageNote() {
  const total = state.notes.filter((n) => !n.deleted).length;
  $('#storageNote').textContent = `${total} catatan · tersimpan offline di perangkat ini`;
}

function updateFilterChip() {
  const chip = $('#filterChip');
  if (state.notebook) {
    chip.hidden = false;
    chip.textContent = `Buku: ${state.notebook}`;
  } else if (state.tag) {
    chip.hidden = false;
    chip.textContent = `#${state.tag}`;
  } else {
    chip.hidden = true;
  }
}

function renderAll() {
  renderSidebar();
  renderList();
  updateFilterChip();
}

/* ---------------- editor ---------------- */

function setSaveState(mode) {
  const el = $('#saveState');
  el.textContent = mode === 'saving' ? 'Menyimpan…' : 'Tersimpan';
  el.classList.toggle('saving', mode === 'saving');
}

function updateStats(note) {
  if (!note) return;
  const body = note.body || '';
  const words = countWords(body);
  const stats = taskStats(note);
  const parts = [`${words} kata`, `${body.length} karakter`];
  if (words) parts.push(`±${Math.max(1, Math.round(words / 200))} mnt baca`);
  if (stats.total) parts.push(`${stats.done}/${stats.total} tugas`);
  const backlinks = notesLinkingTo(note).length;
  if (backlinks) parts.push(`${backlinks} tautan balik`);
  parts.push(`diubah ${fmtFull(note.updatedAt)}`);
  $('#noteStats').textContent = parts.join(' · ');
  $('#noteStats').title = parts.join(' · ');
}

function renderPreview(note) {
  const preview = $('#preview');
  const html = note ? renderMarkdown(note.body || '') : '';
  preview.innerHTML = html || '<p class="empty-md">Belum ada isi untuk dipratinjau.</p>';
  $$('.wikilink', preview).forEach((link) => {
    const name = link.dataset.wikilink || '';
    const exists = !!findNoteByTitle(name);
    link.classList.toggle('new', !exists);
    link.title = exists ? `Buka “${name}”` : `Buat catatan “${name}”`;
  });
}

function setMode(mode, opts = {}) {
  if (!MODE_LABELS[mode]) mode = 'write';
  state.mode = mode;
  ls.set('catatan.mode', mode);

  const wrap = $('.body-wrap');
  wrap.classList.remove('mode-write', 'mode-split', 'mode-preview');
  wrap.classList.add(`mode-${mode}`);

  $('#bodyInput').hidden = mode === 'preview';
  $('#preview').hidden = mode === 'write';

  const btn = $('#previewBtn');
  btn.dataset.mode = mode;
  btn.title = `Mode ${MODE_LABELS[mode]} · klik untuk ganti (Ctrl E)`;
  btn.classList.toggle('active', mode !== 'write');

  const chip = $('#modeChip');
  if (chip) {
    chip.hidden = mode === 'write';
    chip.textContent = MODE_LABELS[mode];
  }

  if (mode !== 'write') renderPreview(currentNote());
  if (mode === 'split') syncPreviewScroll();
  if (!opts.silent && mode === 'write') $('#bodyInput').focus();
  if (!opts.silent) toast(`Mode ${MODE_LABELS[mode]}`);
}

function cycleMode() {
  const index = MODE_ORDER.indexOf(state.mode);
  setMode(MODE_ORDER[(index + 1) % MODE_ORDER.length]);
}

function syncPreviewScroll() {
  const body = $('#bodyInput');
  const preview = $('#preview');
  if (!body || !preview || state.mode !== 'split') return;
  const bodyMax = body.scrollHeight - body.clientHeight;
  const previewMax = preview.scrollHeight - preview.clientHeight;
  if (bodyMax <= 0 || previewMax <= 0) return;
  preview.scrollTop = (body.scrollTop / bodyMax) * previewMax;
}

function renderEditor(note) {
  $('#editor').hidden = false;
  $('#editorEmpty').hidden = true;
  document.body.classList.add('editing');

  $('#titleInput').value = note.title || '';
  $('#notebookInput').value = note.notebook || DEFAULT_NOTEBOOK;
  $('#tagsInput').value = (note.tags || []).join(', ');
  $('#bodyInput').value = note.body || '';
  $('#bodyInput').scrollTop = 0;
  $('#preview').scrollTop = 0;

  $('#pinBtn').classList.toggle('active', !!note.pinned);
  $('#pinBtn').title = note.pinned ? 'Lepas sematan' : 'Sematkan';

  const locked = !!note.deleted;
  $('#titleInput').readOnly = locked;
  $('#bodyInput').readOnly = locked;
  $('#notebookInput').readOnly = locked;
  $('#tagsInput').readOnly = locked;
  $('#fmtBar').hidden = locked;
  if (locked && state.mode === 'preview') setMode('write', { silent: true });

  const banner = $('#noteBanner');
  if (note.deleted) {
    const since = note.deletedAt || note.updatedAt;
    const left = Math.max(0, Math.ceil((since + TRASH_DAYS * DAY_MS - now()) / DAY_MS));
    banner.hidden = false;
    banner.innerHTML = `<span>Di Sampah · otomatis dihapus dalam ${left} hari.</span><button data-banner="restore">Pulihkan</button>`;
  } else if (note.archived) {
    banner.hidden = false;
    banner.innerHTML = '<span>Catatan ini diarsipkan.</span><button data-banner="unarchive">Keluarkan</button>';
  } else {
    banner.hidden = true;
    banner.innerHTML = '';
  }

  updateStats(note);
  setSaveState('saved');
  setMode(state.mode, { silent: true });
}

function closeEditor() {
  flushSave();
  if (state.focus) setFocus(false, { silent: true });
  state.currentId = null;
  document.body.classList.remove('editing');
  $('#editor').hidden = true;
  $('#editorEmpty').hidden = false;
  $('#noteMenu').hidden = true;
  renderList();
  $$('.note-item.active').forEach((el) => el.classList.remove('active'));
}

function openNote(id, opts = {}) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;

  syncEditor();
  flushSave();

  if (state.notebook && (note.notebook || DEFAULT_NOTEBOOK) !== state.notebook) state.notebook = null;
  if (state.tag && !(note.tags || []).includes(state.tag)) state.tag = null;

  state.currentId = id;
  ls.set('catatan.last', id);
  renderEditor(note);
  renderList();
  renderSidebar();
  updateFilterChip();
  $('#noteMenu').hidden = true;
  closeNav();

  if (opts.focus === 'title') {
    const input = $('#titleInput');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  } else if (opts.focus === 'body') {
    $('#bodyInput').focus();
  }
}

function syncEditor() {
  const note = currentNote();
  if (!note || note.deleted) return;

  const title = $('#titleInput').value;
  const body = $('#bodyInput').value;
  const notebook = $('#notebookInput').value.trim() || DEFAULT_NOTEBOOK;
  const tags = $('#tagsInput').value.split(',')
    .map((tag) => tag.trim().replace(/^#/, ''))
    .filter(Boolean)
    .filter((tag, index, arr) => arr.indexOf(tag) === index);

  const unchanged = title === note.title && body === note.body &&
    notebook === note.notebook && tags.join(',') === (note.tags || []).join(',');
  if (unchanged) return;

  if (title !== note.title || body !== note.body) pushHistory(note);

  note.title = title;
  note.body = body;
  note.notebook = notebook;
  note.tags = tags;
  note.updatedAt = now();

  scheduleSave(note);
  updateStats(note);
  if (state.mode !== 'write') renderPreview(note);
  renderList();
  renderSidebar();
  updateFilterChip();
}

function scheduleSync() {
  if (syncFrame) cancelAnimationFrame(syncFrame);
  syncFrame = requestAnimationFrame(() => {
    syncFrame = null;
    syncEditor();
  });
}

function scheduleSave(note) {
  pendingNote = note;
  clearTimeout(saveTimer);
  setSaveState('saving');
  saveTimer = setTimeout(() => {
    const target = pendingNote;
    pendingNote = null;
    saveTimer = null;
    if (target) Store.put(target);
    setSaveState('saved');
  }, 450);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const target = pendingNote;
  pendingNote = null;
  if (target) Store.put(target);
  setSaveState('saved');
}

function cancelPendingSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  pendingNote = null;
  setSaveState('saved');
}

/* ---------------- editing actions ---------------- */

function createNote(preset = {}) {
  syncEditor();
  flushSave();

  const ts = now();
  const notebook = (preset.notebook || state.notebook || DEFAULT_NOTEBOOK).trim() || DEFAULT_NOTEBOOK;
  const note = {
    id: uid(),
    title: preset.title || '',
    body: preset.body || '',
    tags: preset.tags || (state.tag ? [state.tag] : []),
    notebook,
    pinned: !!preset.pinned,
    archived: false,
    deleted: false,
    daily: preset.daily || undefined,
    createdAt: ts,
    updatedAt: ts,
  };

  state.notes.push(note);
  Store.put(note);

  state.view = 'all';
  state.notebook = preset.notebook ? notebook : state.notebook;
  state.query = '';
  $('#searchInput').value = '';
  $('#clearSearch').hidden = true;
  if (state.mode === 'preview') setMode('write', { silent: true });

  renderAll();
  openNote(note.id, { focus: preset.title ? 'body' : 'title' });
  closeNav();
  return note;
}

function togglePin() {
  const note = currentNote();
  if (!note) return;
  syncEditor();
  note.pinned = !note.pinned;
  Store.put(note);
  $('#pinBtn').classList.toggle('active', note.pinned);
  $('#pinBtn').title = note.pinned ? 'Lepas sematan' : 'Sematkan';
  renderAll();
  toast(note.pinned ? 'Catatan disematkan' : 'Sematan dilepas');
}

async function deleteNote(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;

  if (note.deleted) {
    purgeNote(id);
    return;
  }

  note.deleted = true;
  note.deletedAt = now();
  note.pinned = false;
  note.updatedAt = now();
  await Store.put(note);

  if (state.currentId === id) closeEditor();
  renderAll();
  toast('Dipindahkan ke Sampah · pulihkan dalam 30 hari');
}

async function purgeNote(id) {
  if (!confirm('Hapus permanen catatan ini? Tindakan ini tidak bisa dibatalkan.')) return;
  cancelPendingSave();
  state.notes = state.notes.filter((n) => n.id !== id);
  await Store.remove(id);
  if (state.currentId === id) closeEditor();
  renderAll();
  toast('Catatan dihapus permanen');
}

async function restoreNote(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  note.deleted = false;
  note.deletedAt = undefined;
  note.updatedAt = now();
  await Store.put(note);
  closeEditor();
  renderAll();
  toast('Catatan dipulihkan');
}

async function toggleArchive(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  syncEditor();
  note.archived = !note.archived;
  note.updatedAt = now();
  await Store.put(note);

  if (state.currentId === id) renderEditor(note);
  renderAll();
  toast(note.archived ? 'Catatan diarsipkan' : 'Dikeluarkan dari arsip');
}

async function emptyTrash() {
  const ids = state.notes.filter((n) => n.deleted).map((n) => n.id);
  if (!ids.length) return;
  if (!confirm(`Hapus permanen ${ids.length} catatan di sampah?`)) return;

  cancelPendingSave();
  state.notes = state.notes.filter((n) => !n.deleted);
  await Store.removeMany(ids);
  closeEditor();
  renderAll();
  toast('Sampah dikosongkan');
}

function duplicateNote() {
  const note = currentNote();
  if (!note) return;
  syncEditor();
  const ts = now();
  const copy = {
    ...note,
    id: uid(),
    title: `${displayTitle(note)} (salinan)`,
    tags: [...(note.tags || [])],
    pinned: false,
    archived: false,
    deleted: false,
    daily: undefined,
    deletedAt: undefined,
    versions: [],
    createdAt: ts,
    updatedAt: ts,
  };
  state.notes.push(copy);
  Store.put(copy);
  renderAll();
  openNote(copy.id, { focus: 'title' });
  toast('Catatan diduplikat');
}

function toggleTask(noteId, lineIndex, done) {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note || note.deleted) return;
  const lines = note.body.split('\n');
  if (!lines[lineIndex]) return;

  pushHistory(note);
  lines[lineIndex] = lines[lineIndex].replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]');
  note.body = lines.join('\n');
  note.updatedAt = now();
  Store.put(note);

  if (state.currentId === noteId) {
    $('#bodyInput').value = note.body;
    updateStats(note);
    if (state.mode !== 'write') renderPreview(note);
  }
  renderList();
  renderSidebar();
}

/* ---------------- formatting toolbar ---------------- */

function formatText(kind) {
  const textarea = $('#bodyInput');
  if (textarea.readOnly) return;
  if (state.mode === 'preview') setMode('write', { silent: true });
  textarea.focus();

  const value = textarea.value;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = value.slice(start, end);

  const replace = (newValue, selStart, selEnd) => {
    textarea.value = newValue;
    textarea.setSelectionRange(selStart, selEnd);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const wrap = (before, after, placeholder) => {
    const text = selected || placeholder;
    const newValue = value.slice(0, start) + before + text + after + value.slice(end);
    replace(newValue, start + before.length, start + before.length + text.length);
  };

  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEndIndex = value.indexOf('\n', end);
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;

  switch (kind) {
    case 'b':
      wrap('**', '**', 'teks tebal');
      break;
    case 'i':
      wrap('*', '*', 'teks miring');
      break;
    case 'code':
      wrap('`', '`', 'kode');
      break;
    case 'mark':
      wrap('==', '==', 'sorotan');
      break;
    case 'wiki':
      wrap('[[', ']]', 'Judul catatan');
      break;
    case 'link':
      wrap('[', '](https://)', 'teks tautan');
      break;
    case 'quote': {
      const block = value.slice(lineStart, lineEnd);
      const newBlock = block.split('\n').map((line) => (/^\s*>\s?/.test(line) ? line : `> ${line}`)).join('\n');
      const newValue = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
      replace(newValue, lineStart + newBlock.length, lineStart + newBlock.length);
      break;
    }
    case 'table': {
      const table = '| Kolom 1 | Kolom 2 |\n| --- | --- |\n| Isi | Isi |\n';
      const newValue = value.slice(0, lineStart) + table + value.slice(lineStart);
      replace(newValue, lineStart + table.length, lineStart + table.length);
      break;
    }
    case 'h': {
      const line = value.slice(lineStart, lineEnd);
      const newLine = /^#{1,6}\s/.test(line)
        ? line.replace(/^#{1,6}\s+/, '## ')
        : `## ${line}`;
      const newValue = value.slice(0, lineStart) + newLine + value.slice(lineEnd);
      replace(newValue, lineStart + newLine.length, lineStart + newLine.length);
      break;
    }
    case 'task':
    case 'list': {
      const block = value.slice(lineStart, lineEnd);
      const prefix = kind === 'task' ? '- [ ] ' : '- ';
      const newBlock = block.split('\n')
        .map((line) => (/^\s*[-*+]\s/.test(line) ? line : prefix + line))
        .join('\n');
      const newValue = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
      replace(newValue, lineStart + newBlock.length, lineStart + newBlock.length);
      break;
    }
    default:
      break;
  }
}

/* ---------------- menu ---------------- */

function openNoteMenu() {
  const note = currentNote();
  if (!note) return;
  const menu = $('#noteMenu');

  const item = (action, label, icon, extra = '') =>
    `<button data-action="${action}" class="${extra}"><svg class="icon"><use href="#${icon}"/></svg>${label}</button>`;

  let html = '';
  if (note.deleted) {
    html += item('restore', 'Pulihkan catatan', 'i-archive');
    html += item('purge', 'Hapus permanen', 'i-trash', 'danger');
  } else {
    html += item('duplicate', 'Duplikat', 'i-copy');
    html += item('copy', 'Salin markdown', 'i-copy');
    html += item('download', 'Unduh .md', 'i-download');
    html += item('print', 'Cetak / PDF', 'i-print');
    html += '<div class="sep"></div>';
    const linkCount = wikilinksIn(note).length + notesLinkingTo(note).length;
    html += item('links', `Tautan catatan (${linkCount})`, 'i-link');
    html += item('history', `Riwayat versi (${(note.versions || []).length})`, 'i-history');
    html += '<div class="sep"></div>';
    html += item('archive', note.archived ? 'Keluarkan dari arsip' : 'Arsipkan', 'i-archive');
    html += item('trash', 'Pindahkan ke sampah', 'i-trash', 'danger');
  }

  menu.innerHTML = html;
  menu.hidden = false;
}

/* ---------------- sheet, tautan, riwayat, cetak ---------------- */

function showSheet(title, html, onAction = null) {
  sheetAction = onAction;
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheetBody').scrollTop = 0;
  $('#sheetBackdrop').hidden = false;
}

function closeSheet() {
  $('#sheetBackdrop').hidden = true;
  $('#sheetBody').innerHTML = '';
  sheetAction = null;
}

function openLinks() {
  const note = currentNote();
  if (!note) return;
  syncEditor();
  flushSave();

  const outgoing = wikilinksIn(note);
  const incoming = notesLinkingTo(note);

  const outHtml = outgoing.length
    ? outgoing.map((name) => {
      const target = findNoteByTitle(name);
      return `<div class="history-card">
        <div class="history-meta"><strong>${escapeHtml(name)}</strong><span>${target ? 'ada' : 'belum dibuat'}</span></div>
        <div class="history-actions">
          <button class="sheet-btn${target ? '' : ' primary'}" data-act="${target ? 'open' : 'new'}" data-id="${target ? target.id : ''}" data-title="${escapeHtml(name)}">
            ${target ? 'Buka catatan' : 'Buat catatan'}
          </button>
        </div>
      </div>`;
    }).join('')
    : '<p class="sheet-note">Belum ada tautan keluar. Tulis <code>[[Judul catatan]]</code> di isi catatan.</p>';

  const inHtml = incoming.length
    ? incoming.map((n) => `<div class="history-card">
        <div class="history-meta"><strong>${escapeHtml(displayTitle(n))}</strong><span>${escapeHtml(n.notebook || DEFAULT_NOTEBOOK)}</span></div>
        <div class="history-preview">${escapeHtml(snippet(n) || '—')}</div>
        <div class="history-actions"><button class="sheet-btn" data-act="open" data-id="${n.id}">Buka</button></div>
      </div>`).join('')
    : '<p class="sheet-note">Belum ada catatan lain yang menautkan ke sini.</p>';

  showSheet(`Tautan · ${displayTitle(note)}`,
    `<p class="sheet-note">Gunakan <code>[[Judul catatan]]</code> untuk menghubungkan catatan. Klik tautan di pratinjau untuk membukanya.</p>
     <div class="insight-two">
       <div><div class="palette-section" style="padding-left:0">Menautkan ke · ${outgoing.length}</div>${outHtml}</div>
       <div><div class="palette-section" style="padding-left:0">Ditautkan oleh · ${incoming.length}</div>${inHtml}</div>
     </div>`,
    (action, btn) => {
      if (action === 'open') {
        closeSheet();
        openNote(btn.dataset.id);
      } else if (action === 'new') {
        closeSheet();
        createNote({ title: btn.dataset.title });
        toast('Catatan baru dibuat dari tautan');
      }
    });
}

function openHistory() {
  const note = currentNote();
  if (!note) return;
  syncEditor();
  flushSave();
  const versions = note.versions || [];

  const current = `<div class="history-card current">
    <div class="history-meta"><strong>Saat ini</strong><span>${fmtFull(note.updatedAt)}</span><span>${countWords(note.body || '')} kata</span></div>
    <div class="history-title">${escapeHtml(displayTitle(note))}</div>
    <div class="history-preview">${escapeHtml(snippet(note) || '—')}</div>
    <div class="history-actions"><button class="sheet-btn primary" data-act="snapshot">Simpan versi sekarang</button></div>
  </div>`;

  const list = versions.map((version) => `<div class="history-card">
    <div class="history-meta"><strong>${fmtFull(version.at)}</strong><span>${countWords(version.body)} kata</span></div>
    <div class="history-title">${escapeHtml(version.title || 'Tanpa judul')}</div>
    <div class="history-preview">${escapeHtml(snippet({ title: version.title, body: version.body }) || '—')}</div>
    <div class="history-actions">
      <button class="sheet-btn" data-act="restore" data-id="${version.id}">Pulihkan versi ini</button>
    </div>
  </div>`).join('');

  showSheet(`Riwayat · ${displayTitle(note)}`,
    `<p class="sheet-note">Versi dibuat otomatis saat isi berubah (maksimal tiap 90 detik) dan disimpan hingga ${HISTORY_LIMIT} versi terakhir.</p>
     ${current}
     <div class="history-list">${list || '<p class="sheet-note">Belum ada versi lama. Terus menulis, riwayat akan muncul otomatis.</p>'}</div>`,
    (action, btn) => {
      if (action === 'snapshot') {
        const saved = pushHistory(note, true);
        if (saved) Store.put(note);
        toast(saved ? 'Versi sekarang disimpan' : 'Belum ada perubahan untuk disimpan');
        openHistory();
      } else if (action === 'restore') {
        restoreVersion(note, btn.dataset.id);
      }
    });
}

function restoreVersion(note, versionId) {
  const version = (note.versions || []).find((v) => v.id === versionId);
  if (!version) return;
  if (!confirm('Pulihkan versi ini? Isi saat ini akan disimpan sebagai versi baru.')) return;

  pushHistory(note, true);
  note.title = version.title;
  note.body = version.body;
  note.updatedAt = now();
  Store.put(note);
  closeSheet();
  renderEditor(note);
  renderAll();
  toast('Versi lama dipulihkan');
}

function printCurrentNote() {
  const note = currentNote();
  if (!note) return;
  syncEditor();
  flushSave();

  const body = renderMarkdown(note.body || '')
    .replace(/<input[^>]*data-line[^>]*>/g, (tag) => (/checked/.test(tag) ? '☑' : '☐'));
  const tags = (note.tags || []).map((tag) => `#${tag}`).join(' ');
  const meta = [
    note.notebook || DEFAULT_NOTEBOOK,
    tags,
    `Diubah ${fmtFull(note.updatedAt)}`,
  ].filter(Boolean).join(' · ');

  const area = $('#printArea');
  area.innerHTML = `<article class="print-doc">
    <h1>${escapeHtml(displayTitle(note))}</h1>
    <p class="print-meta">${escapeHtml(meta)}</p>
    ${body}
  </article>`;
  area.hidden = false;
  document.body.classList.add('printing');
  toast('Menyiapkan halaman cetak…');

  const cleanup = () => {
    clearTimeout(printCleanupTimer);
    area.hidden = true;
    area.innerHTML = '';
    document.body.classList.remove('printing');
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  clearTimeout(printCleanupTimer);
  printCleanupTimer = setTimeout(cleanup, 15000);
  setTimeout(() => {
    try { window.print(); } catch (err) { console.warn('Cetak tidak didukung.', err); toast('Cetak tidak didukung di perangkat ini'); cleanup(); }
  }, 80);
}

async function copyNoteMarkdown() {
  const note = currentNote();
  if (!note) return;
  syncEditor();
  const title = displayTitle(note);
  const text = `${note.title ? `# ${note.title}\n\n` : ''}${note.body || ''}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('Markdown disalin');
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    document.body.appendChild(helper);
    helper.select();
    try { document.execCommand('copy'); toast('Markdown disalin'); }
    catch { toast('Gagal menyalin'); }
    helper.remove();
  }
}

// Di dalam APK Android, unduhan dialihkan ke jembatan CatatanAndroid agar
// berkas benar-benar tersimpan di folder Download perangkat.
function base64FromText(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const bridge = window.CatatanAndroid;
  if (bridge && typeof bridge.saveFile === 'function') {
    try {
      bridge.saveFile(filename, mime, base64FromText(content));
      return;
    } catch (err) {
      console.warn('Penyimpanan Android gagal, memakai unduhan browser.', err);
    }
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function downloadCurrentNote() {
  const note = currentNote();
  if (!note) return;
  syncEditor();
  const safeName = (displayTitle(note) || 'catatan')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'catatan';
  const text = `${note.title ? `# ${note.title}\n\n` : ''}${note.body || ''}\n`;
  downloadFile(`${safeName}.md`, text, 'text/markdown;charset=utf-8');
  toast('Catatan diunduh');
}

function exportAll() {
  syncEditor();
  flushSave();
  const data = {
    app: 'catatan',
    version: 1,
    exportedAt: new Date().toISOString(),
    notes: state.notes,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(`catatan-backup-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json');
  toast('Cadangan diekspor');
}

async function importFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const rawNotes = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.notes) ? parsed.notes : null);
  if (!rawNotes) throw new Error('Format tidak dikenal');

  let added = 0;
  let skipped = 0;

  for (const raw of rawNotes) {
    const note = normalizeImported(raw);
    if (!note) continue;
    if (state.notes.some((n) => n.id === note.id)) { skipped++; continue; }
    state.notes.push(note);
    await Store.put(note);
    added++;
  }

  renderAll();
  toast(`${added} catatan diimpor${skipped ? `, ${skipped} dilewati (sudah ada)` : ''}`);
}

function normalizeImported(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ts = now();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body
      : (typeof raw.content === 'string' ? raw.content : ''),
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((t) => typeof t === 'string')
        .map((t) => t.trim().replace(/^#/, '')).filter(Boolean)
      : [],
    notebook: typeof raw.notebook === 'string' && raw.notebook.trim()
      ? raw.notebook.trim() : DEFAULT_NOTEBOOK,
    pinned: !!raw.pinned,
    archived: !!raw.archived,
    deleted: !!raw.deleted,
    daily: typeof raw.daily === 'string' ? raw.daily : undefined,
    deletedAt: Number.isFinite(raw.deletedAt) ? raw.deletedAt : (raw.deleted ? ts : undefined),
    versions: sanitizeVersions(raw.versions),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : ts,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : ts,
  };
}

/* ---------------- navigation + filters ---------------- */

function setView(view) {
  syncEditor();
  flushSave();
  state.view = view;
  state.tag = null;
  state.notebook = null;
  state.query = '';
  $('#searchInput').value = '';
  $('#clearSearch').hidden = true;
  closeEditor();
  renderAll();
  closeNav();
}

function filterNotebook(name) {
  syncEditor();
  flushSave();
  if (state.notebook === name) {
    state.notebook = null;
  } else {
    state.notebook = name;
    state.tag = null;
    state.view = 'all';
  }
  state.query = '';
  $('#searchInput').value = '';
  closeEditor();
  renderAll();
  closeNav();
}

function filterTag(tag) {
  syncEditor();
  flushSave();
  if (state.tag === tag) {
    state.tag = null;
  } else {
    state.tag = tag;
    state.notebook = null;
    state.view = 'all';
  }
  state.query = '';
  $('#searchInput').value = '';
  closeEditor();
  renderAll();
  closeNav();
}

/* ---------------- templat, harian, fokus ---------------- */

function shortDate(ts = now()) {
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function longDate(ts = now()) {
  return new Date(ts).toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

const TEMPLATES = [
  {
    id: 'rapat',
    name: 'Rapat',
    icon: 'i-file',
    desc: 'Agenda, notulen, keputusan, dan tindak lanjut.',
    notebook: 'Kerja',
    tags: ['rapat'],
    title: () => `Rapat · ${shortDate()}`,
    body: () => `# Rapat\n\n**Tanggal:** ${longDate()}\n**Peserta:** \n\n## Agenda\n- [ ] \n\n## Notulen\n\n## Keputusan\n- \n\n## Tindak lanjut\n- [ ] \n`,
  },
  {
    id: 'jurnal',
    name: 'Jurnal harian',
    icon: 'i-calendar',
    desc: 'Fokus, syukur, dan refleksi singkat setiap hari.',
    notebook: 'Harian',
    tags: ['jurnal'],
    title: () => `Jurnal · ${shortDate()}`,
    body: () => `# ${longDate()}\n\n## Fokus hari ini\n- [ ] \n\n## Tiga hal yang disyukuri\n- \n- \n- \n\n## Refleksi\n\n## Besok\n- [ ] \n`,
  },
  {
    id: 'proyek',
    name: 'Rencana proyek',
    icon: 'i-chart',
    desc: 'Tujuan, tonggak, risiko, dan langkah berikutnya.',
    notebook: 'Proyek',
    tags: ['proyek'],
    title: () => `Proyek · ${shortDate()}`,
    body: () => `# Nama proyek\n\n> [!NOTE] Ringkasan\n> Tulis satu paragraf tentang proyek ini.\n\n## Tujuan\n- \n\n## Ruang lingkup\n- Termasuk: \n- Tidak termasuk: \n\n## Tonggak\n| Tonggak | Target | Status |\n| --- | --- | --- |\n| Riset | ${shortDate()} | ☐ |\n| Eksekusi | | ☐ |\n| Rilis | | ☐ |\n\n## Risiko\n- \n\n## Langkah berikutnya\n- [ ] \n`,
  },
  {
    id: 'checklist',
    name: 'Checklist tugas',
    icon: 'i-check',
    desc: 'Daftar tugas cepat yang muncul di menu Tugas.',
    notebook: 'Kerja',
    tags: ['tugas'],
    title: () => `Checklist · ${shortDate()}`,
    body: () => `# Checklist · ${shortDate()}\n\n- [ ] Tugas pertama\n- [ ] Tugas kedua\n- [ ] Tugas ketiga\n\n## Catatan\n`,
  },
  {
    id: 'riset',
    name: 'Riset',
    icon: 'i-search',
    desc: 'Pertanyaan, sumber, temuan, dan kesimpulan.',
    notebook: 'Riset',
    tags: ['riset'],
    title: () => `Riset · ${shortDate()}`,
    body: () => `# Topik riset\n\n## Pertanyaan utama\n1. \n\n## Sumber\n- [ ] \n\n## Temuan\n- \n\n## Kesimpulan\n\n## Tautan terkait\n- [[ ]]\n`,
  },
  {
    id: 'review',
    name: 'Review mingguan',
    icon: 'i-history',
    desc: 'Apa yang berhasil, macet, dan prioritas pekan depan.',
    notebook: 'Harian',
    tags: ['review'],
    title: () => `Review mingguan · ${shortDate()}`,
    body: () => `# Review mingguan · ${shortDate()}\n\n## Yang berhasil\n- \n\n## Yang macet\n- \n\n## Pelajaran\n- \n\n## Prioritas pekan depan\n- [ ] \n- [ ] \n- [ ] \n`,
  },
];

function openTemplates() {
  const cards = TEMPLATES.map((tpl) => `<button class="template-card" data-act="use" data-id="${tpl.id}">
    <div class="template-top">
      <span class="template-ico"><svg class="icon"><use href="#${tpl.icon}"/></svg></span>
      <strong>${escapeHtml(tpl.name)}</strong>
    </div>
    <p>${escapeHtml(tpl.desc)}</p>
    <div class="template-tags">${tpl.tags.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join('')}</div>
  </button>`).join('');

  showSheet('Mulai dari templat',
    `<p class="sheet-note">Templat mengisi judul, buku catatan, tag, dan kerangka isi. Semua bisa kamu ubah setelah dibuat.</p>
     <div class="template-grid">${cards}</div>`,
    (action, btn) => {
      if (action !== 'use') return;
      const tpl = TEMPLATES.find((t) => t.id === btn.dataset.id);
      if (!tpl) return;
      closeSheet();
      createNote({
        title: tpl.title(),
        body: tpl.body(),
        notebook: tpl.notebook,
        tags: [...tpl.tags],
      });
      toast(`Templat ${tpl.name} dibuat`);
    });
}

function openDailyNote() {
  syncEditor();
  flushSave();
  const key = dayKey();
  const existing = state.notes.find((n) => n.daily === key && !n.deleted);
  if (existing) {
    openNote(existing.id);
    toast('Catatan harian dibuka');
    return existing;
  }

  const label = longDate();
  const note = createNote({
    title: `Harian · ${label}`,
    body: `# ${label}\n\n## Fokus hari ini\n- [ ] \n\n## Catatan\n\n## Tiga hal yang disyukuri\n- \n- \n- \n\n## Refleksi\n`,
    notebook: 'Harian',
    tags: ['harian'],
    daily: key,
  });
  toast('Catatan harian dibuat');
  return note;
}

function setFocus(on, opts = {}) {
  state.focus = !!on;
  document.body.classList.toggle('focus-mode', state.focus);
  $('#focusBtn').classList.toggle('active', state.focus);
  if (state.focus) closeNav();
  if (!opts.silent) toast(state.focus ? 'Mode fokus · Ctrl Shift F untuk keluar' : 'Mode fokus dimatikan');
}

/* ---------------- insight ---------------- */

function fmtBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function topEntries(map, limit = 5) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'id')).slice(0, limit);
}

function barList(entries) {
  if (!entries.length) return '<p class="sheet-note">Belum ada data.</p>';
  const max = Math.max(1, ...entries.map(([, count]) => count));
  return `<div class="bar-list">${entries.map(([name, count]) => `<div class="bar-row">
    <span class="bar-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
    <span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, Math.round((count / max) * 100))}%"></span></span>
    <span class="bar-count">${count}</span>
  </div>`).join('')}</div>`;
}

function computeInsights() {
  const all = state.notes.filter((n) => !n.deleted);
  const active = all.filter((n) => !n.archived);
  const words = all.reduce((sum, n) => sum + countWords(n.body || ''), 0);
  const tasks = all.reduce((acc, n) => {
    const stats = taskStats(n);
    acc.done += stats.done;
    acc.total += stats.total;
    return acc;
  }, { done: 0, total: 0 });

  const tagCounts = new Map();
  const notebookCounts = new Map();
  const dayCounts = new Map();
  for (const note of all) {
    for (const tag of note.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    const book = note.notebook || DEFAULT_NOTEBOOK;
    notebookCounts.set(book, (notebookCounts.get(book) || 0) + 1);
    const key = dayKey(note.updatedAt);
    dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
  }

  const todayStart = startOfDay();
  const weekday = (new Date(todayStart).getDay() + 6) % 7;
  const weekStart = todayStart - weekday * DAY_MS;
  const start = weekStart - 35 * DAY_MS;
  const maxDay = Math.max(1, ...dayCounts.values());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const ts = start + i * DAY_MS;
    const key = dayKey(ts);
    const count = dayCounts.get(key) || 0;
    let level = 0;
    if (count) {
      if (count >= maxDay) level = 4;
      else if (count >= maxDay * 0.6) level = 3;
      else if (count >= maxDay * 0.3) level = 2;
      else level = 1;
    }
    cells.push({ ts, key, count, level, future: ts > todayStart });
  }

  const activeDays = new Set(all.map((n) => dayKey(n.updatedAt)));
  let streak = 0;
  let cursor = todayStart;
  if (!activeDays.has(dayKey(cursor))) cursor -= DAY_MS;
  while (activeDays.has(dayKey(cursor))) {
    streak++;
    cursor -= DAY_MS;
  }

  const withoutTags = all.filter((n) => !(n.tags || []).length).length;
  const archived = all.filter((n) => n.archived).length;
  const trash = state.notes.filter((n) => n.deleted).length;

  return {
    all, active, words, tasks, tagCounts, notebookCounts, cells, streak,
    activeDays: activeDays.size, withoutTags, archived, trash,
    averageWords: all.length ? Math.round(words / all.length) : 0,
  };
}

function insightsHTML(data) {
  const pct = data.tasks.total ? data.tasks.done / data.tasks.total : 0;
  const pctLabel = Math.round(pct * 100);
  const cells = data.cells.map((cell) => {
    const today = cell.key === dayKey();
    return `<div class="heat-cell l${cell.level}${cell.future ? ' future' : ''}${today ? ' today' : ''}" title="${cell.key} · ${cell.count} catatan"></div>`;
  }).join('');
  const books = topEntries(data.notebookCounts);
  const tags = topEntries(data.tagCounts);

  return `<div class="insight-grid">
      <div class="stat-card hot"><span class="stat-label">Catatan aktif</span><span class="stat-value">${data.active.length}</span><span class="stat-sub">${data.archived} arsip · ${data.trash} sampah</span></div>
      <div class="stat-card blue"><span class="stat-label">Total kata</span><span class="stat-value">${data.words.toLocaleString('id-ID')}</span><span class="stat-sub">±${data.averageWords} kata / catatan</span></div>
      <div class="stat-card green"><span class="stat-label">Tugas selesai</span><span class="stat-value">${data.tasks.done}/${data.tasks.total}</span><span class="stat-sub">${pctLabel}% tuntas</span></div>
      <div class="stat-card pink"><span class="stat-label">Streak menulis</span><span class="stat-value">${data.streak}</span><span class="stat-sub">${data.activeDays} hari aktif</span></div>
    </div>

    <div class="insight-block">
      <h3><svg class="icon"><use href="#i-chart"/></svg> Aktivitas 6 minggu</h3>
      <div class="heatmap-wrap">
        <div class="heatmap">${cells}</div>
        <div class="heat-legend"><span>sepi</span><span class="heat-cell l1"></span><span class="heat-cell l2"></span><span class="heat-cell l3"></span><span class="heat-cell l4"></span><span>ramai</span></div>
      </div>
      <p class="sheet-note" style="margin:8px 0 0">Berdasarkan waktu terakhir catatan diubah.</p>
    </div>

    <div class="insight-two">
      <div class="insight-block">
        <h3><svg class="icon"><use href="#i-check"/></svg> Produktivitas</h3>
        <div class="donut-row">
          <div class="donut" style="--p:${pct}turn"><span>${pctLabel}%</span></div>
          <div class="donut-legend">
            <p><strong>${data.tasks.done}</strong> tugas selesai dari <strong>${data.tasks.total}</strong> total.</p>
            <p><strong>${data.withoutTags}</strong> catatan belum punya tag.</p>
            <p><strong>${data.archived}</strong> catatan diarsipkan.</p>
          </div>
        </div>
      </div>
      <div class="insight-block">
        <h3><svg class="icon"><use href="#i-book"/></svg> Buku catatan teratas</h3>
        ${barList(books)}
      </div>
    </div>

    <div class="insight-two">
      <div class="insight-block">
        <h3><svg class="icon"><use href="#i-tag"/></svg> Tag teratas</h3>
        ${barList(tags)}
      </div>
      <div class="insight-block">
        <h3><svg class="icon"><use href="#i-download"/></svg> Penyimpanan</h3>
        <p class="sheet-note" id="storageInfo">Menghitung pemakaian…</p>
        <p class="sheet-note">${data.all.length} catatan tersimpan offline di perangkat ini. Ekspor cadangan secara berkala.</p>
        <div class="sheet-actions">
          <button class="sheet-btn primary" data-act="export">Ekspor cadangan</button>
          <button class="sheet-btn" data-act="shortcuts">Lihat pintasan</button>
        </div>
      </div>
    </div>`;
}

function openInsights() {
  syncEditor();
  flushSave();
  const data = computeInsights();
  showSheet('Insight ruang kerja', insightsHTML(data), (action) => {
    if (action === 'export') { closeSheet(); exportAll(); }
    else if (action === 'shortcuts') openShortcuts();
  });

  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((estimate) => {
      const el = $('#storageInfo');
      if (!el) return;
      const usage = estimate.usage || 0;
      const quota = estimate.quota || 0;
      el.textContent = quota
        ? `${fmtBytes(usage)} terpakai dari ${fmtBytes(quota)} kuota (${Math.max(1, Math.round((usage / quota) * 100))}%).`
        : `${fmtBytes(usage)} terpakai.`;
    }).catch(() => {
      const el = $('#storageInfo');
      if (el) el.textContent = 'Perkiraan penyimpanan tidak tersedia di perangkat ini.';
    });
  } else {
    const el = $('#storageInfo');
    if (el) el.textContent = 'Perkiraan penyimpanan tidak tersedia di perangkat ini.';
  }
}

/* ---------------- command palette ---------------- */

function fuzzyMatch(text, query) {
  const t = String(text || '').toLowerCase();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { score: 1 };
  if (!t) return null;

  const index = t.indexOf(q);
  if (index !== -1) return { score: 220 - Math.min(180, index) };

  let pos = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, pos);
    if (found === -1) return null;
    score += 12 - Math.min(10, found - pos);
    streak = found === pos ? streak + 1 : 0;
    score += streak * 2;
    pos = found + 1;
  }
  return { score };
}

function highlightMatch(text, query) {
  const escaped = escapeHtml(text);
  const q = String(query || '').trim();
  if (!q) return escaped;
  try {
    const safe = escapeRegExp(escapeHtml(q));
    return escaped.replace(new RegExp(`(${safe})`, 'ig'), '<mark>$1</mark>');
  } catch {
    return escaped;
  }
}

function commandList() {
  const note = currentNote();
  const commands = [
    { id: 'new', label: 'Catatan baru', sub: 'Buat catatan kosong', icon: 'i-plus', key: 'Ctrl N', run: () => createNote() },
    { id: 'daily', label: 'Catatan harian', sub: 'Buka atau buat jurnal hari ini', icon: 'i-calendar', key: 'Ctrl Shift D', run: openDailyNote },
    { id: 'templates', label: 'Dari templat', sub: 'Rapat, proyek, jurnal, checklist, riset…', icon: 'i-file', run: openTemplates },
    { id: 'search', label: 'Fokus pencarian', sub: 'Cari di judul, isi, tag, dan buku catatan', icon: 'i-search', key: '/', run: () => { if (state.focus) setFocus(false, { silent: true }); if (window.innerWidth <= 900) closeEditor(); $('#searchInput').focus(); $('#searchInput').select(); } },
    { id: 'insights', label: 'Buka insight', sub: 'Statistik, streak, dan peta aktivitas', icon: 'i-chart', run: openInsights },
    { id: 'mode', label: 'Ganti mode editor', sub: `Sekarang: ${MODE_LABELS[state.mode]}`, icon: 'i-split', key: 'Ctrl E', run: cycleMode },
    { id: 'focus', label: state.focus ? 'Keluar mode fokus' : 'Mode fokus', sub: 'Sembunyikan panel samping dan daftar', icon: 'i-focus', key: 'Ctrl Shift F', run: () => setFocus(!state.focus) },
    { id: 'theme', label: 'Ganti tema', sub: 'Terang / gelap', icon: 'i-sun', run: toggleTheme },
    { id: 'view-tasks', label: 'Buka tugas', sub: 'Semua checklist dari semua catatan', icon: 'i-check', run: () => setView('tasks') },
    { id: 'view-fav', label: 'Buka disematkan', sub: 'Catatan yang kamu sematkan', icon: 'i-star', run: () => setView('fav') },
    { id: 'view-archive', label: 'Buka arsip', sub: 'Catatan yang disimpan untuk nanti', icon: 'i-archive', run: () => setView('archive') },
    { id: 'view-trash', label: 'Buka sampah', sub: 'Pulihkan atau hapus permanen', icon: 'i-trash', run: () => setView('trash') },
    { id: 'export', label: 'Ekspor cadangan JSON', sub: 'Simpan semua catatan ke satu berkas', icon: 'i-download', run: exportAll },
    { id: 'import', label: 'Impor cadangan JSON', sub: 'Pulihkan catatan dari berkas cadangan', icon: 'i-upload', run: () => $('#importFile').click() },
    { id: 'shortcuts', label: 'Daftar pintasan', sub: 'Semua tombol cepat dan sintaks markdown', icon: 'i-help', key: '?', run: openShortcuts },
  ];

  if (note && !note.deleted) {
    commands.splice(7, 0,
      { id: 'history', label: 'Riwayat versi', sub: `Lihat ${(note.versions || []).length} versi catatan ini`, icon: 'i-history', run: openHistory },
      { id: 'links', label: 'Tautan catatan', sub: 'Tautan keluar dan balik', icon: 'i-link', run: openLinks },
      { id: 'print', label: 'Cetak / PDF', sub: 'Cetak catatan ini atau simpan sebagai PDF', icon: 'i-print', run: printCurrentNote },
      { id: 'duplicate', label: 'Duplikat catatan', sub: 'Buat salinan catatan ini', icon: 'i-copy', run: duplicateNote },
      { id: 'archive-current', label: note.archived ? 'Keluarkan dari arsip' : 'Arsipkan catatan', sub: 'Pindahkan ke arsip', icon: 'i-archive', run: () => toggleArchive(note.id) },
      { id: 'trash-current', label: 'Pindahkan ke sampah', sub: 'Bisa dipulihkan dalam 30 hari', icon: 'i-trash', run: () => deleteNote(note.id) },
    );
  }
  return commands;
}

function buildPaletteItems(rawQuery) {
  const raw = rawQuery.trim();
  const commandOnly = raw.startsWith('>');
  const term = commandOnly ? raw.slice(1).trim() : raw;
  const items = [];

  if (!commandOnly) {
    const notes = state.notes
      .filter((n) => !n.deleted)
      .map((note) => {
        const title = displayTitle(note);
        const titleMatch = fuzzyMatch(title, term);
        let score = titleMatch ? titleMatch.score + 200 : 0;
        if (term && !titleMatch) {
          const hay = `${note.body || ''} ${(note.tags || []).map((tag) => `#${tag}`).join(' ')} ${note.notebook || ''}`.toLowerCase();
          const index = hay.indexOf(term.toLowerCase());
          if (index !== -1) score = 90 - Math.min(70, Math.round(index / 12));
        } else if (!term) {
          score = 100;
        }
        return { note, title, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt)
      .slice(0, 7);

    for (const entry of notes) {
      const book = entry.note.notebook || DEFAULT_NOTEBOOK;
      const tags = (entry.note.tags || []).map((tag) => `#${tag}`).join(' ');
      const preview = snippet(entry.note).slice(0, 80);
      items.push({
        group: 'Catatan',
        icon: 'i-note',
        title: highlightMatch(entry.title, term),
        sub: [book, tags, preview].filter(Boolean).join(' · '),
        key: fmtDate(entry.note.updatedAt),
        run: () => openNote(entry.note.id),
      });
    }
  }

  const commands = commandList()
    .map((command) => ({ command, match: fuzzyMatch(`${command.label} ${command.sub}`, term) }))
    .filter((entry) => entry.match)
    .sort((a, b) => b.match.score - a.match.score)
    .slice(0, commandOnly ? 30 : 10);

  for (const entry of commands) {
    items.push({
      group: 'Perintah',
      icon: entry.command.icon,
      title: highlightMatch(entry.command.label, term),
      sub: entry.command.sub,
      key: entry.command.key || '',
      run: entry.command.run,
    });
  }

  return items;
}

function renderPalette() {
  const results = $('#paletteResults');
  const items = state.paletteItems;
  if (!items.length) {
    results.innerHTML = '<div class="palette-empty"><strong>Tidak ada hasil.</strong><br>Coba kata lain, atau ketik <code>&gt;</code> untuk perintah.</div>';
    $('#paletteHint').textContent = 'Tidak ada hasil';
    return;
  }

  let html = '';
  let group = '';
  items.forEach((item, index) => {
    if (item.group !== group) {
      group = item.group;
      html += `<div class="palette-section">${group}</div>`;
    }
    const selected = index === state.paletteIndex;
    html += `<button class="palette-item${selected ? ' sel' : ''}" data-index="${index}" role="option" aria-selected="${selected}">
      <span class="p-ico"><svg class="icon"><use href="#${item.icon}"/></svg></span>
      <span class="p-main"><span class="p-title">${item.title}</span><span class="p-sub">${escapeHtml(item.sub || '')}</span></span>
      ${item.key ? `<span class="p-key">${escapeHtml(item.key)}</span>` : ''}
    </button>`;
  });
  results.innerHTML = html;
  $('#paletteHint').textContent = `${items.length} hasil`;
}

function updatePaletteSelection() {
  $$('.palette-item', $('#paletteResults')).forEach((el) => {
    const selected = Number(el.dataset.index) === state.paletteIndex;
    el.classList.toggle('sel', selected);
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) el.scrollIntoView({ block: 'nearest' });
  });
}

function refreshPalette() {
  state.paletteItems = buildPaletteItems($('#paletteInput').value);
  state.paletteIndex = 0;
  renderPalette();
}

function openPalette(prefill = '') {
  const backdrop = $('#paletteBackdrop');
  if (!backdrop.hidden) return;
  syncEditor();
  backdrop.hidden = false;
  $('#paletteInput').value = prefill;
  state.paletteItems = buildPaletteItems(prefill);
  state.paletteIndex = 0;
  renderPalette();
  setTimeout(() => {
    const input = $('#paletteInput');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, 20);
}

function closePalette() {
  $('#paletteBackdrop').hidden = true;
  $('#paletteResults').innerHTML = '';
  state.paletteItems = [];
  state.paletteIndex = 0;
}

function movePalette(delta) {
  const count = state.paletteItems.length;
  if (!count) return;
  state.paletteIndex = (state.paletteIndex + delta + count) % count;
  updatePaletteSelection();
}

function runPalette(index) {
  const item = state.paletteItems[index];
  if (!item) return;
  closePalette();
  item.run();
}

/* ---------------- pintasan ---------------- */

function openShortcuts() {
  const rows = [
    ['Command palette', ['Ctrl', 'K']],
    ['Catatan baru', ['Ctrl', 'N']],
    ['Catatan harian', ['Ctrl', 'Shift', 'D']],
    ['Ganti mode editor', ['Ctrl', 'E']],
    ['Mode fokus', ['Ctrl', 'Shift', 'F']],
    ['Simpan sekarang', ['Ctrl', 'S']],
    ['Fokus pencarian', ['/']],
    ['Daftar pintasan', ['?']],
    ['Tutup / kembali', ['Esc']],
  ];
  showSheet('Pintasan & sintaks',
    `<div class="shortcut-grid">
      ${rows.map(([label, keys]) => `<div class="shortcut-row"><span>${label}</span><span class="shortcut-keys">${keys.map((key) => `<kbd>${key}</kbd>`).join('')}</span></div>`).join('')}
    </div>
    <div class="insight-block">
      <h3><svg class="icon"><use href="#i-spark"/></svg> Markdown cepat</h3>
      <p class="sheet-note" style="margin:0">
        <code>[[Judul catatan]]</code> tautan antar catatan · <code>==sorot==</code> penanda ·
        <code>- [ ] tugas</code> checklist · <code>&gt; [!NOTE]</code> callout ·
        <code>| tabel |</code> tabel · <code>&#96;&#96;&#96;</code> blok kode.
      </p>
    </div>
    <div class="sheet-actions">
      <button class="sheet-btn primary" data-act="palette">Buka command palette</button>
      <button class="sheet-btn" data-act="templates">Mulai dari templat</button>
    </div>`,
    (action) => {
      closeSheet();
      if (action === 'palette') openPalette();
      else if (action === 'templates') openTemplates();
    });
}

/* ---------------- sampah otomatis + intent ---------------- */

async function purgeExpiredTrash() {
  const cutoff = now() - TRASH_DAYS * DAY_MS;
  const expired = state.notes.filter((n) => n.deleted && (n.deletedAt || n.updatedAt) < cutoff);
  if (!expired.length) return 0;
  const ids = expired.map((n) => n.id);
  state.notes = state.notes.filter((n) => !expired.includes(n));
  await Store.removeMany(ids);
  return expired.length;
}

function handleIntent() {
  let params;
  try { params = new URLSearchParams(location.search); } catch { return; }
  const action = params.get('new') ? 'new' : (params.get('daily') ? 'daily' : '');
  if (!action) return;
  try { history.replaceState({}, '', location.pathname); } catch {}
  if (action === 'new') createNote();
  else if (action === 'daily') openDailyNote();
}

/* ---------------- theme + misc ---------------- */


function applyTheme() {
  const stored = ls.get('catatan.theme');
  const prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const dark = stored ? stored === 'dark' : prefersDark;

  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const use = $('#themeIcon use');
  if (use) use.setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('#themeBtn').title = dark ? 'Mode terang' : 'Mode gelap';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#141414' : '#f7f4ec');
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  ls.set('catatan.theme', dark ? 'light' : 'dark');
  applyTheme();
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2300);
}

function closeNav() {
  document.body.classList.remove('nav-open');
}

function openNav() {
  document.body.classList.add('nav-open');
}

/* ---------------- seed ---------------- */

function maybeSeed() {
  if (state.notes.length || ls.get('catatan.seeded') === '1') {
    ls.set('catatan.seeded', '1');
    return;
  }

  const seedBody = [
    '# Selamat datang di Catatan',
    '',
    'Aplikasi ini bekerja **offline** dan menyimpan semua tulisan di perangkatmu secara otomatis.',
    '',
    '## Mulai cepat',
    '- [ ] Tekan **Ctrl + K** untuk membuka command palette',
    '- [ ] Buat catatan baru dengan **Ctrl + N** atau tombol +',
    '- [ ] Ganti mode editor dengan **Ctrl + E**: tulis, pisah, pratinjau',
    '- [ ] Coba **Ctrl + Shift + D** untuk catatan harian',
    '- [ ] Buka **Insight** untuk melihat streak dan peta aktivitas',
    '',
    '## Alur kerja yang disarankan',
    '- [ ] Satu catatan untuk satu topik',
    '- [ ] Tulis tugas dengan `- [ ]` lalu selesaikan dari menu **Tugas**',
    '- [ ] Hubungkan catatan dengan `[[Panduan Markdown]]`',
    '- [ ] Arsipkan catatan lama, jangan langsung dihapus',
    '- [ ] Ekspor cadangan secara berkala dari tombol **Ekspor**',
    '',
    '> [!TIP] Tautan internal',
    '> Tulis `[[Panduan Markdown]]` di catatan mana pun. Klik tautannya di pratinjau untuk membuka catatan tujuan.',
    '',
    '> Semua data milikmu. Tidak ada yang dikirim ke internet.',
    '',
    'Selamat bekerja! 🚀',
  ].join('\n');

  const markdownBody = [
    '# Panduan Markdown',
    '',
    'Semua yang kamu tulis di sini bisa diformat dengan markdown sederhana.',
    '',
    '## Format teks',
    '- **tebal**, *miring*, ~~coret~~, `kode`, dan ==sorotan==',
    '- Tautan biasa: [contoh](https://example.com)',
    '- Tautan catatan: [[Selamat datang]]',
    '',
    '## Tabel',
    '| Fitur | Pintasan | Status |',
    '| --- | --- | --- |',
    '| Command palette | Ctrl K | Siap |',
    '| Mode pisah | Ctrl E | Siap |',
    '| Mode fokus | Ctrl Shift F | Siap |',
    '',
    '## Callout',
    '> [!NOTE] Catatan penting',
    '> Callout membantu menonjolkan informasi.',
    '',
    '> [!WARN] Jangan lupa',
    '> Sampah otomatis dibersihkan setelah 30 hari.',
    '',
    '## Tugas',
    '- [x] Coba pratinjau markdown',
    '- [ ] Buka menu Tugas untuk melihat semua checklist',
    '- [ ] Buat templat rapat dari panel kiri',
    '',
    '## Kode',
    '```js',
    'const catatan = "offline";',
    'console.log(catatan);',
    '```',
    '',
    'Kembali ke [[Selamat datang]].',
  ].join('\n');

  const ts = now();
  const welcome = {
    id: uid(),
    title: 'Selamat datang',
    body: seedBody,
    tags: ['mulai'],
    notebook: 'Panduan',
    pinned: true,
    archived: false,
    deleted: false,
    createdAt: ts,
    updatedAt: ts,
  };
  const guide = {
    id: uid(),
    title: 'Panduan Markdown',
    body: markdownBody,
    tags: ['panduan', 'markdown'],
    notebook: 'Panduan',
    pinned: false,
    archived: false,
    deleted: false,
    createdAt: ts - 1000,
    updatedAt: ts - 1000,
  };

  state.notes.push(welcome, guide);
  Store.put(welcome);
  Store.put(guide);
  ls.set('catatan.seeded', '1');
}

/* ---------------- events ---------------- */

function bindEvents() {
  // list + tasks
  $('#noteList').addEventListener('click', (event) => {
    const taskRow = event.target.closest('.task-row');
    if (taskRow) {
      const checkbox = event.target.closest('.task-check');
      if (checkbox) {
        toggleTask(taskRow.dataset.note, Number(taskRow.dataset.line), checkbox.checked);
      } else {
        openNote(taskRow.dataset.note);
      }
      return;
    }

    const item = event.target.closest('.note-item');
    if (item) {
      openNote(item.dataset.id);
      return;
    }

    const action = event.target.closest('[data-action]');
    if (action && action.dataset.action === 'new') createNote();
  });

  // sidebar
  $('#sideNav').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-view]');
    if (btn) { setView(btn.dataset.view); return; }
    const action = event.target.closest('[data-action]');
    if (action && action.dataset.action === 'insights') openInsights();
  });

  $('#notebookList').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-notebook]');
    if (btn) filterNotebook(btn.dataset.notebook);
  });

  $('#tagList').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-tag]');
    if (btn) filterTag(btn.dataset.tag);
  });

  $('#openNavBtn').addEventListener('click', openNav);
  $('#scrim').addEventListener('click', closeNav);

  // new note
  ['#newNoteBtn', '#newBtn', '#emptyNewBtn'].forEach((sel) => {
    $(sel).addEventListener('click', () => createNote());
  });
  $('#paletteBtn').addEventListener('click', () => openPalette());
  $('#templateBtn').addEventListener('click', openTemplates);
  $('#dailyBtn').addEventListener('click', openDailyNote);

  $('#newNotebookBtn').addEventListener('click', () => {
    const name = prompt('Nama buku catatan baru:');
    if (name && name.trim()) createNote({ notebook: name.trim() });
  });

  // search + sort
  $('#searchInput').addEventListener('input', (event) => {
    state.query = event.target.value;
    $('#clearSearch').hidden = !event.target.value;
    renderList();
  });
  $('#clearSearch').addEventListener('click', () => {
    $('#searchInput').value = '';
    state.query = '';
    $('#clearSearch').hidden = true;
    renderList();
    $('#searchInput').focus();
  });
  $('#sortSelect').addEventListener('change', (event) => {
    state.sort = event.target.value;
    ls.set('catatan.sort', state.sort);
    renderList();
  });

  // editor inputs
  ['#titleInput', '#bodyInput', '#notebookInput', '#tagsInput'].forEach((sel) => {
    $(sel).addEventListener('input', scheduleSync);
  });
  $('#titleInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('#bodyInput').focus();
    }
  });
  $('#tagsInput').addEventListener('blur', () => {
    const note = currentNote();
    if (!note) return;
    $('#tagsInput').value = (note.tags || []).join(', ');
  });
  $('#notebookInput').addEventListener('blur', () => {
    if (!$('#notebookInput').value.trim()) {
      $('#notebookInput').value = DEFAULT_NOTEBOOK;
      scheduleSync();
    }
  });

  // editor actions
  $('#backBtn').addEventListener('click', closeEditor);
  $('#focusBtn').addEventListener('click', () => setFocus(!state.focus));
  $('#pinBtn').addEventListener('click', togglePin);
  $('#previewBtn').addEventListener('click', cycleMode);
  $('#menuBtn').addEventListener('click', openNoteMenu);
  $('#emptyTrashBtn').addEventListener('click', emptyTrash);

  $('#noteMenu').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const note = currentNote();
    $('#noteMenu').hidden = true;
    if (!note) return;

    if (action === 'duplicate') duplicateNote();
    else if (action === 'copy') copyNoteMarkdown();
    else if (action === 'download') downloadCurrentNote();
    else if (action === 'print') printCurrentNote();
    else if (action === 'links') openLinks();
    else if (action === 'history') openHistory();
    else if (action === 'archive') toggleArchive(note.id);
    else if (action === 'trash') deleteNote(note.id);
    else if (action === 'restore') restoreNote(note.id);
    else if (action === 'purge') purgeNote(note.id);
  });

  $('#noteBanner').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-banner]');
    if (!btn) return;
    const note = currentNote();
    if (!note) return;
    if (btn.dataset.banner === 'restore') restoreNote(note.id);
    else if (btn.dataset.banner === 'unarchive') toggleArchive(note.id);
  });

  $('#fmtBar').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-fmt]');
    if (btn) formatText(btn.dataset.fmt);
  });

  // preview: wikilink + checkboxes
  $('#preview').addEventListener('click', (event) => {
    const link = event.target.closest('[data-wikilink]');
    if (!link) return;
    event.preventDefault();
    const name = link.dataset.wikilink;
    const target = findNoteByTitle(name);
    if (target) {
      openNote(target.id);
      toast(`Membuka “${displayTitle(target)}”`);
    } else {
      createNote({ title: name });
      toast('Catatan baru dibuat dari tautan');
    }
  });

  $('#preview').addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[type="checkbox"][data-line]');
    if (!checkbox) return;
    const note = currentNote();
    if (!note) return;
    if (note.deleted) { renderPreview(note); return; }
    toggleTask(note.id, Number(checkbox.dataset.line), checkbox.checked);
    if (state.mode !== 'write') renderPreview(note);
  });

  // theme, backup, install
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#exportBtn').addEventListener('click', exportAll);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      await importFile(file);
    } catch (err) {
      console.warn(err);
      toast('Gagal mengimpor: file tidak valid');
    } finally {
      event.target.value = '';
    }
  });

  // command palette
  $('#paletteInput').addEventListener('input', refreshPalette);
  $('#paletteInput').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); movePalette(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); movePalette(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); runPalette(state.paletteIndex); }
    else if (event.key === 'Tab') { event.preventDefault(); movePalette(event.shiftKey ? -1 : 1); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePalette(); }
  });
  $('#paletteResults').addEventListener('click', (event) => {
    const item = event.target.closest('.palette-item');
    if (item) runPalette(Number(item.dataset.index));
  });
  $('#paletteResults').addEventListener('mousemove', (event) => {
    const item = event.target.closest('.palette-item');
    if (!item) return;
    const index = Number(item.dataset.index);
    if (index === state.paletteIndex) return;
    state.paletteIndex = index;
    updatePaletteSelection();
  });
  $('#paletteBackdrop').addEventListener('mousedown', (event) => {
    if (event.target === event.currentTarget) closePalette();
  });

  // sheet / modal
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#sheetBackdrop').addEventListener('mousedown', (event) => {
    if (event.target === event.currentTarget) closeSheet();
  });
  $('#sheetBody').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-act]');
    if (btn && sheetAction) sheetAction(btn.dataset.act, btn);
  });

  // split preview scroll sync
  $('#bodyInput').addEventListener('scroll', syncPreviewScroll);

  // close menu when clicking elsewhere
  document.addEventListener('click', (event) => {
    const menu = $('#noteMenu');
    if (menu.hidden) return;
    if (event.target.closest('#noteMenu') || event.target.closest('#menuBtn')) return;
    menu.hidden = true;
  });

  // keyboard shortcuts
  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const target = event.target;
    const typing = target && (/^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable);

    // Dialog terbuka: biarkan input palette / tombol sheet menangani sendiri.
    if (!$('#paletteBackdrop').hidden || !$('#sheetBackdrop').hidden) {
      if (event.key === 'Escape') {
        if (!$('#paletteBackdrop').hidden) closePalette();
        else closeSheet();
        event.preventDefault();
      }
      return;
    }

    if (mod && event.shiftKey && key === 'f') {
      event.preventDefault();
      setFocus(!state.focus);
    } else if (mod && event.shiftKey && key === 'd') {
      event.preventDefault();
      openDailyNote();
    } else if (mod && key === 'k') {
      event.preventDefault();
      openPalette();
    } else if (mod && key === 'n') {
      event.preventDefault();
      createNote();
    } else if (mod && key === 's') {
      event.preventDefault();
      syncEditor();
      flushSave();
      toast('Tersimpan');
    } else if (mod && key === 'e') {
      event.preventDefault();
      cycleMode();
    } else if (!typing && event.key === '/') {
      event.preventDefault();
      if (state.focus) setFocus(false, { silent: true });
      if (window.innerWidth <= 900) closeEditor();
      $('#searchInput').focus();
      $('#searchInput').select();
    } else if (!typing && event.key === '?') {
      event.preventDefault();
      openShortcuts();
    } else if (event.key === 'Escape') {
      const menu = $('#noteMenu');
      if (!menu.hidden) { menu.hidden = true; return; }
      if (document.body.classList.contains('nav-open')) { closeNav(); return; }
      if (state.focus) { setFocus(false); return; }
      if (document.body.classList.contains('editing') && window.innerWidth <= 900) closeEditor();
      else if (state.query) {
        $('#searchInput').value = '';
        state.query = '';
        $('#clearSearch').hidden = true;
        renderList();
      }
    }
  });

  // save before leaving
  window.addEventListener('beforeunload', () => {
    syncEditor();
    if (pendingNote) Store.put(pendingNote);
  });

  window.addEventListener('pagehide', () => {
    if (pendingNote) Store.put(pendingNote);
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) closeNav();
  });

  // install prompt
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => {});
    deferredInstallPrompt = null;
    $('#installBtn').hidden = true;
  });

  // follow system theme if user hasn't chosen
  if (window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (!ls.get('catatan.theme')) applyTheme(); };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }
}

/* ---------------- init ---------------- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('Service worker gagal didaftarkan.', err);
  });
}

// Didaftarkan sejak awal agar event pemasangan dari browser tidak terlewat.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $('#installBtn').hidden = false;
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  $('#installBtn').hidden = true;
  toast('Catatan berhasil dipasang');
});

async function init() {
  applyTheme();
  $('#sortSelect').value = state.sort;
  setMode(state.mode, { silent: true });
  bindEvents();

  await Store.init();
  maybeSeed();
  const purged = await purgeExpiredTrash();

  renderAll();

  const last = state.currentId ? state.notes.find((n) => n.id === state.currentId) : null;
  if (last && !last.deleted && window.innerWidth > 900) {
    openNote(last.id);
  } else {
    closeEditor();
    renderAll();
  }

  if (purged) toast(`${purged} catatan sampah lama dihapus otomatis`);

  handleIntent();

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  registerServiceWorker();
}

document.addEventListener('DOMContentLoaded', init);
