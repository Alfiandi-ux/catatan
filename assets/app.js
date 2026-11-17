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

/* ---------------- state ---------------- */

const state = {
  notes: [],
  view: 'all',        // all | fav | tasks | archive | trash
  query: '',
  tag: null,
  notebook: null,
  sort: ls.get('catatan.sort') || 'updated',
  currentId: ls.get('catatan.last') || null,
  preview: false,
};

let pendingNote = null;
let saveTimer = null;
let syncFrame = null;
let toastTimer = null;
let deferredInstallPrompt = null;

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
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const safe = /^(https?:|mailto:|\/|\.|#)/i.test(url) ? url : '#';
    return token(`<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });
  out = out.replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]}])/g, (url) =>
    token(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
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

    if (/^>\s?/.test(trimmed)) {
      flush(); closeList();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      i--;
      html += `<blockquote>${inlineMd(quote.join('\n')).replace(/\n/g, '<br>')}</blockquote>`;
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
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s*)?/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_`~]/g, '')
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
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const stats = taskStats(note);
  const parts = [`${words} kata`, `${body.length} karakter`];
  if (stats.total) parts.push(`${stats.done}/${stats.total} tugas`);
  parts.push(`diubah ${fmtFull(note.updatedAt)}`);
  $('#noteStats').textContent = parts.join(' · ');
}

function renderPreview(note) {
  const preview = $('#preview');
  const html = note ? renderMarkdown(note.body || '') : '';
  preview.innerHTML = html || '<p class="empty-md">Belum ada isi untuk dipratinjau.</p>';
}

function setPreview(on) {
  state.preview = on;
  $('#previewBtn').classList.toggle('active', on);
  $('#bodyInput').hidden = on;
  $('#preview').hidden = !on;
  if (on) renderPreview(currentNote());
  else $('#bodyInput').focus();
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
  if (locked && state.preview) setPreview(false);

  const banner = $('#noteBanner');
  if (note.deleted) {
    banner.hidden = false;
    banner.innerHTML = '<span>Catatan ini ada di Sampah.</span><button data-banner="restore">Pulihkan</button>';
  } else if (note.archived) {
    banner.hidden = false;
    banner.innerHTML = '<span>Catatan ini diarsipkan.</span><button data-banner="unarchive">Keluarkan</button>';
  } else {
    banner.hidden = true;
    banner.innerHTML = '';
  }

  updateStats(note);
  setSaveState('saved');
  if (state.preview) renderPreview(note);
}

function closeEditor() {
  flushSave();
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
  state.currentId = id;
  ls.set('catatan.last', id);
  renderEditor(note);
  renderList();
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

  note.title = title;
  note.body = body;
  note.notebook = notebook;
  note.tags = tags;
  note.updatedAt = now();

  scheduleSave(note);
  updateStats(note);
  if (state.preview) renderPreview(note);
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
    title: '',
    body: '',
    tags: preset.tags || (state.tag ? [state.tag] : []),
    notebook,
    pinned: false,
    archived: false,
    deleted: false,
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

  renderAll();
  openNote(note.id, { focus: 'title' });
  closeNav();
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
  note.pinned = false;
  note.updatedAt = now();
  await Store.put(note);

  if (state.currentId === id) closeEditor();
  renderAll();
  toast('Dipindahkan ke Sampah');
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

  lines[lineIndex] = lines[lineIndex].replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]');
  note.body = lines.join('\n');
  note.updatedAt = now();
  Store.put(note);

  if (state.currentId === noteId) {
    $('#bodyInput').value = note.body;
    updateStats(note);
    if (state.preview) renderPreview(note);
  }
  renderList();
  renderSidebar();
}

/* ---------------- formatting toolbar ---------------- */

function formatText(kind) {
  const textarea = $('#bodyInput');
  if (textarea.readOnly) return;
  if (state.preview) setPreview(false);
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
    html += '<div class="sep"></div>';
    html += item('archive', note.archived ? 'Keluarkan dari arsip' : 'Arsipkan', 'i-archive');
    html += item('trash', 'Pindahkan ke sampah', 'i-trash', 'danger');
  }

  menu.innerHTML = html;
  menu.hidden = false;
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
    '- [ ] Buat catatan baru dengan **Ctrl + N** atau tombol +',
    '- [ ] Coba tombol mata untuk melihat **pratinjau markdown**',
    '- [ ] Sematkan catatan penting agar selalu di atas',
    '- [ ] Rapikan pekerjaan dengan **buku catatan** dan **tag**',
    '',
    '## Alur kerja yang disarankan',
    '- [ ] Satu catatan untuk satu topik',
    '- [ ] Tulis tugas dengan `- [ ]` lalu selesaikan dari menu **Tugas**',
    '- [ ] Arsipkan catatan lama, jangan langsung dihapus',
    '- [ ] Ekspor cadangan secara berkala dari tombol **Ekspor**',
    '',
    '> Semua data milikmu. Tidak ada yang dikirim ke internet.',
    '',
    'Selamat bekerja! 🚀',
  ].join('\n');

  const ts = now();
  const note = {
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

  state.notes.push(note);
  Store.put(note);
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
    if (btn) setView(btn.dataset.view);
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
  $('#pinBtn').addEventListener('click', togglePin);
  $('#previewBtn').addEventListener('click', () => setPreview(!state.preview));
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

  // preview checkboxes
  $('#preview').addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[type="checkbox"][data-line]');
    if (!checkbox) return;
    const note = currentNote();
    if (!note) return;
    if (note.deleted) { renderPreview(note); return; }
    toggleTask(note.id, Number(checkbox.dataset.line), checkbox.checked);
    if (state.preview) renderPreview(note);
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

    if (mod && key === 'n') {
      event.preventDefault();
      createNote();
    } else if (mod && key === 'k') {
      event.preventDefault();
      if (window.innerWidth <= 900) closeEditor();
      $('#searchInput').focus();
      $('#searchInput').select();
    } else if (mod && key === 's') {
      event.preventDefault();
      syncEditor();
      flushSave();
      toast('Tersimpan');
    } else if (event.key === 'Escape') {
      const menu = $('#noteMenu');
      if (!menu.hidden) { menu.hidden = true; return; }
      if (document.body.classList.contains('nav-open')) { closeNav(); return; }
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
  bindEvents();

  await Store.init();
  maybeSeed();

  renderAll();

  const last = state.currentId ? state.notes.find((n) => n.id === state.currentId) : null;
  if (last && !last.deleted && window.innerWidth > 900) {
    openNote(last.id);
  } else {
    closeEditor();
    renderAll();
  }

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  registerServiceWorker();
}

document.addEventListener('DOMContentLoaded', init);
