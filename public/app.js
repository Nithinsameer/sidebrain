/* Sidebrain — dashboard app (vanilla JS, no build step) */
'use strict';

const APP_NAME = 'Sidebrain';

// ---------------------------------------------------------------- constants

const TAG_COLORS = [
  { key: 'sky',     label: 'Blue',     hex: '#0ea5e9' },
  { key: 'green',   label: 'Green',    hex: '#22c55e' },
  { key: 'amber',   label: 'Amber',    hex: '#f59e0b' },
  { key: 'red',     label: 'Red',      hex: '#ef4444' },
  { key: 'rose',    label: 'Pink',     hex: '#f43f5e' },
  { key: 'teal',    label: 'Teal',     hex: '#14b8a6' },
  { key: 'orange',  label: 'Orange',   hex: '#f97316' },
  { key: 'cyan',    label: 'Cyan',     hex: '#06b6d4' },
  { key: 'lime',    label: 'Lime',     hex: '#84cc16' },
  { key: 'fuchsia', label: 'Fuchsia',  hex: '#d946ef' },
  { key: 'slate',   label: 'Slate',    hex: '#94a3b8' },
  { key: 'rose2',   label: 'Rose',     hex: '#fb7185' },
  { key: 'peach',   label: 'Peach',    hex: '#fdba74' },
  { key: 'lavender',label: 'Lavender', hex: '#c4b5fd' },
];
const colorOf = (key) => TAG_COLORS.find((c) => c.key === key) || TAG_COLORS[0];

const FONTS = {
  courier: { label: 'Typewriter', css: 'var(--font-courier)' },
  modern:  { label: 'Modern',     css: 'var(--font-modern)' },
  classic: { label: 'Classic',    css: 'var(--font-classic)' },
};

// ---------------------------------------------------------------- state

let S = { settings: {}, tags: [], messages: [], reminders: [] };
const UI = {
  view: 'feed',
  search: '',
  dateFilter: { field: 'created', date: '' },
  activeTags: new Set(),
  composeFiles: [],       // {name, type, data(dataURL)}
  composeTagIds: new Set(),
  composeList: false,
  calCursor: null,        // Date for calendar month
  calSelected: null,      // 'YYYY-MM-DD'
  weekCursor: null,       // Date inside the displayed week
  lightbox: { urls: [], i: 0 },
  notifiedReminders: new Set(),
};

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// ---------------------------------------------------------------- api

async function api(method, path, body) {
  const res = await fetch('/api/' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let err = 'Failed to save. Please try again.';
    try { err = (await res.json()).error || err; } catch {}
    throw new Error(err);
  }
  return res.json();
}

async function loadState() { S = await api('GET', 'state'); }

async function patchSettings(patch) {
  Object.assign(S.settings, patch);
  applySettings();
  try { await api('PATCH', 'settings', patch); } catch { toast('Failed to save settings'); }
}

// ---------------------------------------------------------------- utils

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

function richText(text) {
  let html = esc(text);
  html = html.replace(URL_RE, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  html = html.replace(/(^|\s)(#[\p{L}\p{N}_-]+)/gu, '$1<span class="hashtag">$2</span>');
  return html;
}

function firstUrl(text) {
  const m = String(text || '').match(URL_RE);
  return m ? m[0] : null;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function tagById(id) { return S.tags.find((t) => t.id === id); }

function tagStyle(tag) {
  const c = colorOf(tag.color);
  return `--tag-hex:${c.hex};--tag-text:${c.hex};--tag-bg:color-mix(in srgb, ${c.hex} 10%, transparent);--tag-border:color-mix(in srgb, ${c.hex} 55%, transparent)`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

function tagPill(tag) {
  return `<span class="tagpill" style="${tagStyle(tag)}"><span class="swatch"></span>${esc(tag.name)}</span>`;
}

// ---------------------------------------------------------------- settings → dom

function applySettings() {
  const s = S.settings;
  document.body.classList.toggle('light', s.theme === 'light');
  document.body.classList.toggle('compact', !!s.compact);
  document.body.classList.toggle('hide-tagnav', !!s.hideTagNav);
  document.body.style.setProperty('--dashboard-font', (FONTS[s.font] || FONTS.courier).css);
}

// ---------------------------------------------------------------- filtering

const ARCHIVE_AGE_MS = 14 * 86400000;

// old, unpinned, non-open-task notes count as archived and hide from the feed
function isArchived(m) {
  if (m.pinned || (m.task && !m.done)) return false;
  return Date.now() - Date.parse(m.createdAt) > ARCHIVE_AGE_MS;
}

function visibleMessages() {
  let msgs = S.messages.filter((m) => !m.deletedAt);
  if (UI.activeTags.size) {
    msgs = msgs.filter((m) => m.tagIds.some((id) => UI.activeTags.has(id)));
  }
  if (UI.dateFilter.date) {
    msgs = msgs.filter((m) => UI.dateFilter.field === 'due'
      ? m.plannedFor === UI.dateFilter.date
      : dayKey(m.createdAt) === UI.dateFilter.date);
  }
  const q = UI.search.trim().toLowerCase();
  if (q) {
    msgs = msgs.filter((m) => {
      const text = m.text.toLowerCase();
      if (text.includes(q)) return true;
      if (q.length >= 3 && fuzzyMatch(text, q)) return true;
      const d = new Date(m.createdAt);
      const dateStrs = [
        fmtTime(m.createdAt).toLowerCase(),
        dayKey(m.createdAt),
        d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).toLowerCase(),
      ];
      return dateStrs.some((s) => s.includes(q));
    });
  }
  msgs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return msgs;
}

// loose subsequence match: all query chars appear in order ("grcries" → "groceries")
function fuzzyMatch(text, q) {
  let i = 0;
  for (const ch of text) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

function msgDay(m) { return m.plannedFor || dayKey(m.createdAt); }

function fmtDay(key) {
  return new Date(key + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtClock(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------- card html

const linkTitleCache = new Map(JSON.parse(localStorage.getItem('mc_link_titles') || '[]'));
function saveLinkCache() {
  localStorage.setItem('mc_link_titles', JSON.stringify([...linkTitleCache.entries()].slice(-300)));
}

function cardHtml(m, { compactActions = false, draggable = false } = {}) {
  const tags = m.tagIds.map(tagById).filter(Boolean);
  let body;
  if (m.list) {
    const lines = m.text.split('\n').filter((l) => l.trim());
    body = lines.map((line, i) => {
      const done = (m.checked || []).includes(i);
      return `<div class="todo-item ${done ? 'done' : ''}" data-line="${i}"><span class="box">${done ? '✓' : ''}</span><span class="label">${richText(line)}</span></div>`;
    }).join('');
  } else if (m.task) {
    body = `<div class="todo-item ${m.done ? 'done' : ''}" data-taskdone><span class="box">${m.done ? '✓' : ''}</span><span class="label">${richText(m.text)}</span></div>`;
  } else {
    body = `<div class="text">${richText(m.text)}</div>`;
  }

  const imgs = (m.files || []).filter((f) => f.type.startsWith('image/'));
  const others = (m.files || []).filter((f) => !f.type.startsWith('image/'));
  let filesHtml = '';
  if (imgs.length || others.length) {
    filesHtml = `<div class="imggrid">` +
      imgs.map((f, i) => `<img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy" data-lightbox="${i}" />`).join('') +
      others.map((f) => `<a class="filecard" href="${esc(f.url)}" target="_blank">📄 ${esc(f.name)}</a>`).join('') +
      `</div>`;
  }

  let linkHtml = '';
  const url = !m.list && firstUrl(m.text);
  if (url) {
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    const title = linkTitleCache.get(url);
    linkHtml = `<a class="linkpreview" href="${esc(url)}" target="_blank" rel="noopener" data-linkurl="${esc(url)}">
      <span class="lp-title">${title ? esc(title) : 'Click to open'}</span><span class="lp-host">${esc(host)}</span></a>`;
  }

  const actions = compactActions ? '' : `
    <div class="actions">
      <button data-act="pin" title="${m.pinned ? 'Unpin' : 'Pin to top'}">${m.pinned ? '📌' : svg('pin')}</button>
      <button data-act="copy" title="Copy message">${svg('copy')}</button>
      <button data-act="todo" title="To-Do List">${svg('list')}</button>
      <button data-act="week" title="${m.task ? 'Remove from week planner' : 'Send to week planner'}">${svg('calcheck')}</button>
      <button data-act="tag" title="Edit tags">${svg('tag')}</button>
      <button data-act="edit" title="Edit note">${svg('pencil')}</button>
      <button data-act="del" class="danger" title="Delete">${svg('trash')}</button>
    </div>`;

  return `<article class="card ${m.pinned ? 'pinned' : ''} ${m.task && m.done ? 'task-done' : ''}" data-id="${m.id}" ${draggable ? 'draggable="true"' : ''}>
    ${m.pinned ? '<span class="pin-flag">Pinned</span>' : ''}
    ${actions}
    <button class="more" data-more title="Options">⋯</button>
    ${body}
    ${filesHtml}
    ${linkHtml}
    <div class="meta">
      ${tags.map(tagPill).join('')}
      ${m.plannedFor ? `<span class="duechip">Due ${fmtDay(m.plannedFor)}${m.dueTime ? ' · ' + fmtClock(m.dueTime) : ''}</span>` : ''}
      <span class="time">${fmtTime(m.createdAt)}</span>
    </div>
  </article>`;
}

function svg(name) {
  const icons = {
    pin: '<path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1Z"/>',
    copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    list: '<path d="M3 6h.01M3 12h.01M3 18h.01M8 6h13M8 12h13M8 18h13"/>',
    tag: '<path d="M12 2H2v10l9.29 9.29a1 1 0 0 0 1.42 0l8.58-8.58a1 1 0 0 0 0-1.42Z"/><path d="M7 7h.01"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    calcheck: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4"/>',
    trash: '<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  };
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[name] || ''}</svg>`;
}

// lazily resolve link titles
async function hydrateLinkTitles(root) {
  for (const el of $$('[data-linkurl]', root)) {
    const url = el.dataset.linkurl;
    if (linkTitleCache.has(url)) continue;
    linkTitleCache.set(url, null); // in-flight marker
    api('POST', 'link-title', { url }).then(({ title }) => {
      if (title) {
        linkTitleCache.set(url, title);
        saveLinkCache();
        $$(`[data-linkurl="${CSS.escape(url)}"] .lp-title`).forEach((t) => { t.textContent = title; });
      } else linkTitleCache.delete(url);
    }).catch(() => linkTitleCache.delete(url));
  }
}

// ---------------------------------------------------------------- feed view

function renderFeed() {
  const root = $('#feedGroups');
  let msgs = visibleMessages();

  // hide the archive unless toggled on — but any active filter searches everything
  const filtering = UI.search || UI.activeTags.size || UI.dateFilter.date;
  const archivedCount = msgs.filter(isArchived).length;
  if (!filtering && !UI.showArchive) msgs = msgs.filter((m) => !isArchived(m));

  if (!msgs.length) {
    const filtered = UI.search || UI.activeTags.size || UI.dateFilter.date;
    root.innerHTML = `<div class="empty">
      <b>${filtered ? 'No results found.' : 'Nothing here yet.'}</b>
      ${filtered
        ? `<button class="btn" id="btnClearFilters" style="margin-top:10px">Clear filters</button>`
        : `Whatever's on your mind, send it. It'll be here when you need it.`}
    </div>`;
    const cf = $('#btnClearFilters');
    if (cf) cf.onclick = clearFilters;
    return;
  }

  // one flat card dump: pinned first, then newest first
  const sorted = [...msgs].sort((a, b) => (b.pinned - a.pinned) || (new Date(b.createdAt) - new Date(a.createdAt)));
  root.innerHTML = `<div class="masonry">${sorted.map((m) => cardHtml(m)).join('')}</div>` +
    (!filtering && archivedCount ? `<div class="archbar"><button class="chip ghost" id="btnArchiveToggle">🗄 ${UI.showArchive ? 'Hide archive' : `Show archive (${archivedCount})`}</button></div>` : '');
  const at = $('#btnArchiveToggle');
  if (at) at.onclick = () => { UI.showArchive = !UI.showArchive; renderFeed(); };
  hydrateLinkTitles(root);
}

function clearFilters() {
  UI.search = '';
  $('#search').value = '';
  UI.activeTags.clear();
  UI.dateFilter = { field: 'created', date: '' };
  $('#filterDate').value = '';
  $('#btnFilter').classList.remove('active');
  renderAll();
}

// card action dispatch (event delegation on document)
document.addEventListener('click', async (e) => {
  const card = e.target.closest('.card[data-id], .canvas-card[data-id]');
  const moreBtn = e.target.closest('[data-more]');
  if (moreBtn && card) {
    e.preventDefault();
    const m = S.messages.find((x) => x.id === card.dataset.id);
    if (m) openCardSheet(m);
    return;
  }
  const actBtn = e.target.closest('[data-act]');
  if (actBtn && card) {
    e.preventDefault();
    await handleCardAction(actBtn.dataset.act, card.dataset.id);
    return;
  }
  // to-do line toggle
  const todo = e.target.closest('.todo-item');
  if (todo && card && !e.target.closest('a')) {
    const m = S.messages.find((x) => x.id === card.dataset.id);
    if (!m) return;
    if (todo.hasAttribute('data-taskdone')) {
      m.done = !m.done;
      renderCurrentView();
      api('PATCH', 'messages/' + m.id, { done: m.done }).catch(() => toast('Failed to save'));
      return;
    }
    const line = +todo.dataset.line;
    const set = new Set(m.checked || []);
    set.has(line) ? set.delete(line) : set.add(line);
    m.checked = [...set];
    renderCurrentView();
    api('PATCH', 'messages/' + m.id, { checked: m.checked }).catch(() => toast('Failed to save'));
    return;
  }
  // lightbox open
  const img = e.target.closest('.imggrid img');
  if (img && card) {
    const m = S.messages.find((x) => x.id === card.dataset.id);
    const urls = (m.files || []).filter((f) => f.type.startsWith('image/')).map((f) => f.url);
    openLightbox(urls, +img.dataset.lightbox || 0);
  }
});

async function handleCardAction(act, id) {
  const m = S.messages.find((x) => x.id === id);
  if (!m) return;
  try {
    if (act === 'pin') {
      m.pinned = !m.pinned;
      renderCurrentView();
      await api('PATCH', 'messages/' + id, { pinned: m.pinned });
      toast(m.pinned ? 'Pinned to top' : 'Unpinned');
    } else if (act === 'copy') {
      await navigator.clipboard.writeText(m.text);
      toast('Copied to clipboard');
    } else if (act === 'todo') {
      m.list = !m.list;
      renderCurrentView();
      await api('PATCH', 'messages/' + id, { list: m.list });
    } else if (act === 'week') {
      m.task = !m.task;
      renderCurrentView();
      await api('PATCH', 'messages/' + id, { task: m.task });
      toast(m.task ? (m.plannedFor ? 'Added to week planner' : 'Added to week planner — Inbox') : 'Removed from week planner');
    } else if (act === 'tag') {
      openTagAssignModal(m);
    } else if (act === 'edit') {
      openEditModal(m);
    } else if (act === 'canvas') {
      m.canvas = m.canvas || { on: false, x: 40, y: 40 };
      m.canvas.on = !m.canvas.on;
      renderCurrentView();
      await api('PATCH', 'messages/' + id, { canvas: m.canvas });
      toast(m.canvas.on ? 'Added to canvas' : 'Removed from canvas');
    } else if (act === 'del') {
      m.deletedAt = new Date().toISOString(); // soft delete — recoverable from Settings → Trash
      renderCurrentView();
      await api('DELETE', 'messages/' + id);
      toast('Moved to trash');
    }
  } catch (err) { toast(err.message); }
}

// ---------------------------------------------------------------- composer

function renderComposeExtras() {
  $('#composePreviews').innerHTML = UI.composeFiles.map((f, i) => `
    <div class="pv">${f.type.startsWith('image/')
      ? `<img src="${f.data}" alt="" />`
      : `<span class="pdf">${esc(f.name)}</span>`}
      <button data-rm="${i}" title="Remove">✕</button>
    </div>`).join('');
  $('#composeTags').innerHTML = [...UI.composeTagIds].map(tagById).filter(Boolean).map(tagPill).join('');
  $('#btnListMode').classList.toggle('on', UI.composeList);
  updateSendState();
}

function updateSendState() {
  $('#btnSend').disabled = !$('#composeText').value.trim() && !UI.composeFiles.length;
}

async function sendMessage() {
  const text = $('#composeText').value.trim();
  if (!text && !UI.composeFiles.length) return;
  $('#btnSend').disabled = true;
  try {
    const msg = await api('POST', 'messages', {
      text,
      files: UI.composeFiles,
      tagIds: [...UI.composeTagIds],
      list: UI.composeList,
    });
    S.messages.unshift(msg);
    $('#composeText').value = '';
    $('#composeText').style.height = 'auto';
    UI.composeFiles = [];
    UI.composeTagIds.clear();
    UI.composeList = false;
    renderComposeExtras();
    renderFeed();
    toast('Saved to your ' + APP_NAME);
    // untagged notes get AI-classified in the background — pick up the result
    if (!msg.tagIds.length && msg.text) {
      setTimeout(async () => {
        try {
          await loadState();
          renderTagbar();
          renderCurrentView();
        } catch {}
      }, 3500);
    }
  } catch (err) { toast(err.message); }
  updateSendState();
}

function initComposer() {
  const ta = $('#composeText');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
    updateSendState();
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendMessage(); }
  });
  $('#btnSend').addEventListener('click', sendMessage);
  $('#btnListMode').addEventListener('click', () => { UI.composeList = !UI.composeList; renderComposeExtras(); });
  $('#btnAttach').addEventListener('click', () => $('#fileInput').click());
  $('#btnComposeTag').addEventListener('click', () => openComposeTagModal());

  $('#fileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      if (UI.composeFiles.length >= 10) { toast('Maximum 10 files'); break; }
      if (f.size > 15 * 1024 * 1024) { toast('Each file must be under 15MB'); continue; }
      const data = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(f);
      });
      UI.composeFiles.push({ name: f.name, type: f.type, data });
    }
    renderComposeExtras();
  });

  $('#composePreviews').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]');
    if (b) { UI.composeFiles.splice(+b.dataset.rm, 1); renderComposeExtras(); }
  });

  // paste images straight into composer
  ta.addEventListener('paste', async (e) => {
    const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
    if (!items.length) return;
    for (const it of items) {
      if (UI.composeFiles.length >= 10) break;
      const f = it.getAsFile();
      const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
      UI.composeFiles.push({ name: 'pasted-image.png', type: f.type, data });
    }
    renderComposeExtras();
  });
}

// ---------------------------------------------------------------- tag bar

function renderTagbar() {
  const bar = $('#tagbar');
  const counts = {};
  for (const m of S.messages) for (const t of m.tagIds) counts[t] = (counts[t] || 0) + 1;

  const allOn = UI.activeTags.size === 0;
  bar.innerHTML = `
    <button class="chip ${allOn ? 'on' : ''}" data-tagfilter="">All</button>
    ${S.tags.map((t) => {
      const on = UI.activeTags.has(t.id);
      return `<button class="chip ${on ? 'on' : ''}" data-tagfilter="${t.id}" style="${tagStyle(t)}">
        <span class="swatch"></span>${esc(t.name)}${counts[t.id] ? ` <span style="opacity:.55">${counts[t.id]}</span>` : ''}</button>`;
    }).join('')}
    <button class="chip ghost" id="btnAddTag">+ Add Tag</button>
    <button class="chip ghost" id="btnManageTags">Manage</button>`;

  $$('[data-tagfilter]', bar).forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.tagfilter;
    if (!id) UI.activeTags.clear();
    else UI.activeTags.has(id) ? UI.activeTags.delete(id) : UI.activeTags.add(id);
    renderAll();
  }));
  $('#btnAddTag').addEventListener('click', () => openTagEditModal(null));
  $('#btnManageTags').addEventListener('click', openTagManagerModal);
}

// ---------------------------------------------------------------- modals

function openModal(html) {
  const root = $('#modalRoot');
  const box = $('#modalBox');
  box.innerHTML = `<button class="iconbtn x">✕</button>` + html;
  root.classList.add('open');
  $('.x', box).onclick = closeModal;
  $('.backdrop', root).onclick = closeModal;
  return box;
}
function closeModal() { $('#modalRoot').classList.remove('open'); }
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); closeLightbox(); }
});

// ---- create / edit tag
function openTagEditModal(tag) {
  const isNew = !tag;
  const color = { v: tag ? tag.color : 'sky' };
  const box = openModal(`
    <h2>${isNew ? 'Create Tag' : 'Edit Tag'}</h2>
    <p class="sub">The tag name becomes your trigger — include <b>#name</b> in any note to auto-tag it.</p>
    <div class="field">
      <label>Tag name</label>
      <input type="text" id="tagName" placeholder="idea" value="${tag ? esc(tag.name) : ''}" maxlength="30" />
    </div>
    <div class="field">
      <label>Color</label>
      <div class="swatches">${TAG_COLORS.map((c) =>
        `<button data-color="${c.key}" class="${c.key === color.v ? 'on' : ''}" style="--sw:${c.hex}" title="${c.label}"></button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label>Additional keywords</label>
      <input type="text" id="tagKeywords" placeholder="thought, brainstorm" value="${tag ? esc((tag.keywords || []).join(', ')) : ''}" />
      <div class="hint">Add alternate words that also trigger this tag, separated by commas.</div>
    </div>
    <div class="err" id="tagErr"></div>
    <div class="footrow">
      ${isNew ? '' : `<button class="btn danger" id="tagDelete">Delete Tag</button>`}
      <button class="btn primary" id="tagSave">${isNew ? 'Create Tag' : 'Save'}</button>
    </div>`);

  $$('.swatches button', box).forEach((b) => b.onclick = () => {
    color.v = b.dataset.color;
    $$('.swatches button', box).forEach((x) => x.classList.toggle('on', x === b));
  });
  $('#tagSave', box).onclick = async () => {
    const name = $('#tagName', box).value.trim().replace(/^#/, '');
    const keywords = $('#tagKeywords', box).value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!name) { showErr(box, 'Tag name is required.'); return; }
    try {
      if (isNew) {
        const t = await api('POST', 'tags', { name, color: color.v, keywords });
        S.tags.push(t);
      } else {
        const t = await api('PATCH', 'tags/' + tag.id, { name, color: color.v, keywords });
        Object.assign(tag, t);
      }
      closeModal();
      renderAll();
      toast(isNew ? 'Tag created' : 'Tag updated');
    } catch (err) { showErr(box, err.message); }
  };
  const del = $('#tagDelete', box);
  if (del) del.onclick = async () => {
    if (!confirm(`Delete tag "${tag.name}"? Notes keep their text; the tag is removed from them.`)) return;
    await api('DELETE', 'tags/' + tag.id);
    S.tags = S.tags.filter((t) => t.id !== tag.id);
    S.messages.forEach((m) => { m.tagIds = m.tagIds.filter((x) => x !== tag.id); });
    UI.activeTags.delete(tag.id);
    S.settings.boardColumns = (S.settings.boardColumns || []).filter((x) => x !== tag.id);
    closeModal();
    renderAll();
    toast('Tag deleted');
  };
  $('#tagName', box).focus();
}

function showErr(box, msg) {
  const e = $('.err', box);
  if (e) { e.textContent = msg; e.classList.add('show'); }
}

// ---- tag manager
function openTagManagerModal() {
  const counts = {};
  for (const m of S.messages) for (const t of m.tagIds) counts[t] = (counts[t] || 0) + 1;
  const box = openModal(`
    <h2>Tags</h2>
    <p class="sub">Click a tag to edit it. Tag names double as #triggers in your notes.</p>
    <div id="tagRows">${S.tags.length ? S.tags.map((t) => `
      <div class="tagrow" data-id="${t.id}" style="cursor:pointer">
        <span class="swatch" style="background:${colorOf(t.color).hex}"></span>
        <div><div class="name">${esc(t.name)}</div>
        ${(t.keywords || []).length ? `<div class="kw">also: ${esc(t.keywords.join(', '))}</div>` : ''}</div>
        <span class="count">${counts[t.id] || 0} notes</span>
      </div>`).join('') : `<p class="sub">No tags yet. Use Add Tag to create one.</p>`}
    </div>
    <div class="footrow"><button class="btn primary" id="mgrAdd">+ Add Tag</button></div>`);
  $$('#tagRows .tagrow', box).forEach((row) => row.onclick = () => {
    const t = tagById(row.dataset.id);
    if (t) openTagEditModal(t);
  });
  $('#mgrAdd', box).onclick = () => openTagEditModal(null);
}

// ---- assign tags to a message
function openTagAssignModal(m) {
  if (!S.tags.length) { openTagEditModal(null); return; }
  const sel = new Set(m.tagIds);
  const box = openModal(`
    <h2>Tags for this note</h2>
    <p class="sub">Pick as many as you like.</p>
    <div class="compose-tags" style="margin-bottom:6px">${S.tags.map((t) => `
      <button class="chip ${sel.has(t.id) ? 'on' : ''}" data-id="${t.id}" style="${tagStyle(t)}">
        <span class="swatch"></span>${esc(t.name)}</button>`).join('')}
    </div>
    <div class="footrow"><button class="btn primary" id="assignSave">Save</button></div>`);
  $$('.chip', box).forEach((c) => c.onclick = () => {
    const id = c.dataset.id;
    sel.has(id) ? sel.delete(id) : sel.add(id);
    c.classList.toggle('on', sel.has(id));
  });
  $('#assignSave', box).onclick = async () => {
    m.tagIds = [...sel];
    closeModal();
    renderAll();
    api('PATCH', 'messages/' + m.id, { tagIds: m.tagIds }).catch(() => toast('Failed to save'));
  };
}

// ---- compose tag picker
function openComposeTagModal() {
  if (!S.tags.length) { openTagEditModal(null); return; }
  const box = openModal(`
    <h2>Tag this note</h2>
    <p class="sub">Or just type #tagname anywhere in the note.</p>
    <div class="compose-tags" style="margin-bottom:6px">${S.tags.map((t) => `
      <button class="chip ${UI.composeTagIds.has(t.id) ? 'on' : ''}" data-id="${t.id}" style="${tagStyle(t)}">
        <span class="swatch"></span>${esc(t.name)}</button>`).join('')}
    </div>
    <div class="footrow"><button class="btn primary" id="ctDone">Done</button></div>`);
  $$('.chip', box).forEach((c) => c.onclick = () => {
    const id = c.dataset.id;
    UI.composeTagIds.has(id) ? UI.composeTagIds.delete(id) : UI.composeTagIds.add(id);
    c.classList.toggle('on', UI.composeTagIds.has(id));
  });
  $('#ctDone', box).onclick = () => { closeModal(); renderComposeExtras(); };
}

// ---- card action sheet (⋯ on touch devices; every option labeled)
function openCardSheet(m) {
  const preview = (m.text.split('\n')[0] || '').slice(0, 60);
  const box = openModal(`
    <h2>Note options</h2>
    <p class="sub">${esc(preview) || 'Attachment'}</p>
    <div class="sheet-due">
      <span class="dlabel">Due</span>
      <input type="date" id="sheetDue" value="${m.plannedFor || ''}" />
      <input type="time" id="sheetDueTime" value="${m.dueTime || ''}" title="Optional time — you get a push at this moment" />
      ${m.plannedFor || m.dueTime ? '<button class="btn" id="sheetDueClear">Clear</button>' : ''}
    </div>
    <p class="sub" style="margin:6px 2px 0">Date puts it in that day's plan + morning digest; add a time to also get a push at that exact moment.</p>
    <div class="sheet-rows">
      <button data-s="pin"><span class="ic">📌</span>${m.pinned ? 'Unpin from top' : 'Pin to top'}</button>
      <button data-s="edit"><span class="ic">✏️</span>Edit text</button>
      <button data-s="tag"><span class="ic">🏷️</span>Edit tags</button>
      <button data-s="todo"><span class="ic">☑️</span>${m.list ? 'Turn checklist off' : 'Turn into checklist'}<span class="hint">a checkbox per line</span></button>
      <button data-s="week"><span class="ic">📅</span>${m.task ? 'Remove from week planner' : 'Send to week planner'}<span class="hint">${m.task ? '' : 'lands in Inbox'}</span></button>
      <button data-s="copy"><span class="ic">📋</span>Copy text</button>
      <button data-s="del" class="danger"><span class="ic">🗑️</span>Move to trash<span class="hint">recoverable for 30 days</span></button>
    </div>`);

  $$('.sheet-rows [data-s]', box).forEach((b) => b.onclick = async () => {
    const act = b.dataset.s;
    closeModal();
    if (act === 'edit') return openEditModal(m);
    if (act === 'tag') return openTagAssignModal(m);
    await handleCardAction(act, m.id);
  });

  const saveDue = async () => {
    const date = $('#sheetDue', box).value || null;
    const time = $('#sheetDueTime', box).value || null;
    // a time with no date means today
    m.plannedFor = date || (time ? dayKey(new Date().toISOString()) : null);
    m.dueTime = time;
    if (m.plannedFor) m.task = true;
    renderCurrentView();
    try {
      await api('PATCH', 'messages/' + m.id, { plannedFor: m.plannedFor, dueTime: m.dueTime, task: m.task });
      toast(m.plannedFor
        ? 'Due ' + fmtDay(m.plannedFor) + (m.dueTime ? ' · ' + fmtClock(m.dueTime) : '')
        : 'Due date cleared');
    } catch { toast('Failed to save'); }
    openCardSheet(m);
  };
  $('#sheetDue', box).onchange = saveDue;
  $('#sheetDueTime', box).onchange = saveDue;
  const clr = $('#sheetDueClear', box);
  if (clr) clr.onclick = async () => {
    m.plannedFor = null;
    m.dueTime = null;
    renderCurrentView();
    try { await api('PATCH', 'messages/' + m.id, { plannedFor: null, dueTime: null }); toast('Due date cleared'); } catch {}
    openCardSheet(m);
  };
}

// ---- edit note text
function openEditModal(m) {
  const box = openModal(`
    <h2>Edit note</h2>
    <div class="field" style="margin-top:12px">
      <textarea id="editText" rows="6">${esc(m.text)}</textarea>
    </div>
    <div class="sheet-due">
      <span class="dlabel">Due</span>
      <input type="date" id="editDue" value="${m.plannedFor || ''}" />
      <input type="time" id="editDueTime" value="${m.dueTime || ''}" />
    </div>
    <p class="sub" style="margin:6px 2px 0">Add a time to get a push at that moment. Leave both empty for no due date.</p>
    <div class="err" id="editErr"></div>
    <div class="footrow"><button class="btn primary" id="editSave">Save</button></div>`);
  const ta = $('#editText', box);
  ta.focus();
  $('#editSave', box).onclick = async () => {
    const date = $('#editDue', box).value || null;
    const time = $('#editDueTime', box).value || null;
    const plannedFor = date || (time ? dayKey(new Date().toISOString()) : null);
    try {
      const updated = await api('PATCH', 'messages/' + m.id, {
        text: ta.value,
        plannedFor,
        dueTime: time,
        task: m.task || !!plannedFor,
      });
      Object.assign(m, updated);
      closeModal();
      renderCurrentView();
      toast('Note updated');
    } catch (err) { showErr(box, err.message); }
  };
}

// ---- reminders
function openRemindersModal() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const upcoming = [...S.reminders].sort((a, b) => new Date(a.due) - new Date(b.due));

  const box = openModal(`
    <h2>Reminders</h2>
    <p class="sub">MindChuk will nudge you here when a reminder comes due.</p>
    <div class="field"><label>What should we remind you about?</label>
      <input type="text" id="remText" placeholder="Follow up on that idea..." /></div>
    <div style="display:flex;gap:10px">
      <div class="field" style="flex:1"><label>Date</label><input type="date" id="remDate" value="${today}" /></div>
      <div class="field" style="flex:1"><label>Time</label><input type="time" id="remTime" value="${pad(now.getHours())}:${pad(now.getMinutes())}" /></div>
    </div>
    <div class="err" id="remErr"></div>
    <div class="footrow"><button class="btn primary" id="remSave">Set Reminder</button></div>
    <div style="margin-top:16px" id="remList">
      ${upcoming.length ? upcoming.map((r) => {
        const overdue = !r.done && new Date(r.due) < now;
        return `<div class="remrow ${r.done ? 'done' : ''} ${overdue ? 'overdue' : ''}" data-id="${r.id}">
          <span class="box" data-toggle>${r.done ? '✓' : ''}</span>
          <div><div class="rt">${esc(r.text)}</div><div class="rd">${fmtTime(r.due)}${overdue ? ' · overdue' : ''}</div></div>
          <button class="del" data-del title="Delete">✕</button>
        </div>`;
      }).join('') : '<p class="sub">Showing all reminders — none yet.</p>'}
    </div>`);

  $('#remSave', box).onclick = async () => {
    const text = $('#remText', box).value.trim();
    const date = $('#remDate', box).value;
    const time = $('#remTime', box).value;
    if (!text) return showErr(box, 'Please describe what you want to be reminded about.');
    if (!date || !time) return showErr(box, 'Fill in all date and time fields.');
    const due = new Date(`${date}T${time}`);
    if (due <= new Date()) return showErr(box, 'That time is already in the past. Please set a future time.');
    try {
      const r = await api('POST', 'reminders', { text, due: due.toISOString() });
      S.reminders.push(r);
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      openRemindersModal();
      renderReminderDot();
      toast('Reminder set');
    } catch (err) { showErr(box, err.message); }
  };

  $$('#remList .remrow', box).forEach((row) => {
    const id = row.dataset.id;
    $('[data-toggle]', row).onclick = async () => {
      const r = S.reminders.find((x) => x.id === id);
      r.done = !r.done;
      await api('PATCH', 'reminders/' + id, { done: r.done });
      openRemindersModal();
      renderReminderDot();
    };
    $('[data-del]', row).onclick = async () => {
      if (!confirm('Delete this reminder?')) return;
      S.reminders = S.reminders.filter((x) => x.id !== id);
      await api('DELETE', 'reminders/' + id);
      openRemindersModal();
      renderReminderDot();
    };
  });
}

function renderReminderDot() {
  const due = S.reminders.some((r) => !r.done && new Date(r.due) <= new Date());
  $('#btnReminders').classList.toggle('has-due', due);
}

function checkDueReminders() {
  const now = new Date();
  for (const r of S.reminders) {
    if (r.done || UI.notifiedReminders.has(r.id)) continue;
    if (new Date(r.due) <= now) {
      UI.notifiedReminders.add(r.id);
      const banner = $('#dueBanner');
      banner.innerHTML = `<span class="bell">🔔</span><div><b>${esc(r.text)}</b><div style="font-size:11px;color:var(--text-faint)">${fmtTime(r.due)}</div></div>
        <button class="btn" id="dueDone">Done</button><button class="iconbtn" id="dueClose">✕</button>`;
      banner.classList.add('show');
      $('#dueDone').onclick = async () => {
        r.done = true;
        banner.classList.remove('show');
        renderReminderDot();
        api('PATCH', 'reminders/' + r.id, { done: true });
      };
      $('#dueClose').onclick = () => banner.classList.remove('show');
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('MindChuk reminder', { body: r.text });
      }
    }
  }
  renderReminderDot();
}

// ---- settings
function openSettingsModal() {
  const s = S.settings;
  const box = openModal(`
    <h2>Settings</h2>
    <p class="sub">Everything is stored locally in <b>data/db.json</b>.</p>

    <div class="setrow">
      <div class="info"><b>Light mode</b><span>Switch the dashboard to a bright color theme.</span></div>
      <button class="switch ${s.theme === 'light' ? 'on' : ''}" id="setTheme" title="Toggle light mode"></button>
    </div>

    <div class="setrow">
      <div class="info"><b>Dashboard font</b><span>Pick the typeface used across your dashboard.</span></div>
      <div class="segmented" style="width:230px">
        ${Object.entries(FONTS).map(([k, f]) =>
          `<button data-font="${k}" class="${(s.font || 'courier') === k ? 'on' : ''}" style="font-family:${f.css}">${f.label}</button>`).join('')}
      </div>
    </div>

    <div class="setrow">
      <div class="info"><b>Compact view</b><span>Smaller cards, more notes on screen.</span></div>
      <button class="switch ${s.compact ? 'on' : ''}" id="setCompact"></button>
    </div>

    <div class="setrow">
      <div class="info"><b>Hide tag nav bar</b><span>Tuck the tag filter row away.</span></div>
      <button class="switch ${s.hideTagNav ? 'on' : ''}" id="setTagnav"></button>
    </div>

    <div class="setrow">
      <div class="info"><b>Circulations</b><span>Scheduled AI runs (morning briefing, weekly review, ...) pushed to your phone.</span></div>
      <button class="btn" id="openCirculations">Manage</button>
    </div>

    <div class="setrow" style="flex-wrap:wrap">
      <div class="info"><b>Discord capture</b><span>Queued capture: message your capture channel from anywhere — Discord holds it until this Mac picks it up (✅ = saved). Needs a bot token + channel ID.</span></div>
      <div style="display:flex;gap:8px;width:100%;margin-top:4px">
        <input type="password" id="dcBotToken" placeholder="bot token" value="${esc(S.settings.discordBotToken || '')}"
          style="flex:1.2;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;outline:none" />
        <input type="text" id="dcChannel" placeholder="channel ID" value="${esc(S.settings.discordCaptureChannel || '')}"
          style="flex:.8;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;outline:none" />
        <button class="btn" id="dcSave">Save</button>
      </div>
    </div>

    <div class="setrow">
      <div class="info"><b>Trash</b><span>Deleted notes are recoverable for 30 days.</span></div>
      <button class="btn" id="openTrash">Open trash (${S.messages.filter((m) => m.deletedAt).length})</button>
    </div>

    <div class="setrow">
      <div class="info"><b>Export ${APP_NAME}</b><span>Download all your notes as a CSV file. Nightly snapshots land in <b>data/backups/</b> (last 14 kept).</span></div>
      <a class="btn" href="/api/export.csv" download>Export CSV</a>
    </div>

    <div class="setrow">
      <div class="info"><b>Use from your phone</b><span>${S.meta && S.meta.lanUrl
        ? `Same Wi-Fi: open <b>${S.meta.lanUrl}/app</b>, then Share → Add to Home Screen. For anywhere-access, install Tailscale on both devices.`
        : 'Connect this machine to a network to get a phone URL.'}</span></div>
    </div>

    <div class="setrow">
      <div class="info"><b>Capture token</b><span>Lets Apple Shortcuts (voice capture) post into your feed via <b>POST /api/capture</b>.</span></div>
      <button class="btn" id="copyToken">Copy token</button>
    </div>

    <div class="setrow" style="flex-wrap:wrap">
      <div class="info"><b>AI assistant</b><span>Powers the <b>Ask</b> tab and voice-capture cleanup. Paste an OpenAI API key (gpt-4o-mini costs pennies). For free options: a Groq key with base URL <b>https://api.groq.com/openai/v1</b>, or local Ollama with <b>http://localhost:11434/v1</b>.</span></div>
      <div style="display:grid;gap:8px;width:100%;margin-top:4px">
        <input type="password" id="aiKey" placeholder="API key — sk-..." value="${esc(S.settings.openaiKey || '')}"
          style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;outline:none" />
        <div style="display:flex;gap:8px">
          <input type="text" id="aiBaseUrl" placeholder="base URL (optional)" value="${esc(S.settings.aiBaseUrl || '')}"
            style="flex:1.2;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;outline:none" />
          <input type="text" id="aiModel" placeholder="model (default gpt-4o-mini)" value="${esc(S.settings.aiModel || '')}"
            style="flex:.8;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;outline:none" />
        </div>
        <button class="btn" id="aiSave" style="justify-self:end">Save AI settings</button>
      </div>
    </div>

    <div class="setrow" style="flex-wrap:wrap">
      <div class="info"><b>Push notifications</b><span>Fill in any channel(s) you use — pushes go to all of them. Discord is the most reliable on iPhone; ntfy is the simplest; Telegram works too.</span></div>
      <div style="display:grid;gap:8px;width:100%;margin-top:4px">
        <input type="text" id="ntfyTopic" placeholder="ntfy topic — e.g. sidebrain-${(S.settings.captureToken || 'topic').slice(0, 8)}"
          value="${esc(S.settings.ntfyTopic || '')}"
          style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;outline:none" />
        <input type="text" id="discordWebhook" placeholder="Discord webhook URL — https://discord.com/api/webhooks/…"
          value="${esc(S.settings.discordWebhook || '')}"
          style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;outline:none" />
        <div style="display:flex;gap:8px">
          <input type="text" id="telegramToken" placeholder="Telegram bot token (optional)"
            value="${esc(S.settings.telegramToken || '')}"
            style="flex:1.4;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;outline:none" />
          <input type="text" id="telegramChatId" placeholder="chat id"
            value="${esc(S.settings.telegramChatId || '')}"
            style="flex:.6;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;outline:none" />
        </div>
        <button class="btn primary" id="ntfySave" style="justify-self:end">Save &amp; test all</button>
      </div>
    </div>

    <div class="setrow">
      <div class="info"><b>Morning task digest</b><span>One push each morning with today's and overdue tasks from the week planner.</span></div>
      <select id="digestHour" style="padding:7px 10px;background:var(--bg);border:1px solid var(--border);border-radius:9px;outline:none">
        <option value="">Off</option>
        ${[6, 7, 8, 9, 10, 12].map((h) => `<option value="${h}" ${S.settings.digestHour === h ? 'selected' : ''}>${h > 11 ? h - 12 || 12 : h} ${h >= 12 ? 'PM' : 'AM'}</option>`).join('')}
      </select>
    </div>`);

  $('#digestHour', box).onchange = function () {
    patchSettings({ digestHour: this.value === '' ? null : +this.value, lastDigestDay: null });
    toast(this.value === '' ? 'Digest off' : 'Digest set for ' + this.options[this.selectedIndex].text);
  };

  $('#openTrash', box).onclick = openTrashModal;
  $('#openCirculations', box).onclick = openCirculationsModal;
  $('#dcSave', box).onclick = () => {
    patchSettings({
      discordBotToken: $('#dcBotToken', box).value.trim(),
      discordCaptureChannel: $('#dcChannel', box).value.trim(),
      discordLastMsgId: null, // re-baseline so old history isn't ingested
    });
    toast($('#dcBotToken', box).value.trim() ? 'Discord capture saved — message the channel to test' : 'Discord capture off');
  };

  $('#aiSave', box).onclick = () => {
    patchSettings({
      openaiKey: $('#aiKey', box).value.trim(),
      aiBaseUrl: $('#aiBaseUrl', box).value.trim(),
      aiModel: $('#aiModel', box).value.trim(),
    });
    toast($('#aiKey', box).value.trim() ? 'AI settings saved — try the Ask tab' : 'AI key cleared');
  };

  $('#ntfySave', box).onclick = async () => {
    const payload = {
      topic: $('#ntfyTopic', box).value.trim(),
      discordWebhook: $('#discordWebhook', box).value.trim(),
      telegramToken: $('#telegramToken', box).value.trim(),
      telegramChatId: $('#telegramChatId', box).value.trim(),
    };
    Object.assign(S.settings, { ntfyTopic: payload.topic, discordWebhook: payload.discordWebhook, telegramToken: payload.telegramToken, telegramChatId: payload.telegramChatId });
    if (!payload.topic && !payload.discordWebhook && !(payload.telegramToken && payload.telegramChatId)) {
      try { await api('POST', 'ntfy-test', payload); } catch {}
      toast('Push notifications turned off');
      return;
    }
    try {
      const { channels } = await api('POST', 'ntfy-test', payload);
      const sent = [channels.ntfy && 'ntfy', channels.discord && 'Discord', channels.telegram && 'Telegram'].filter(Boolean);
      toast(sent.length ? `Test sent via ${sent.join(' + ')} — check your phone` : 'No channel accepted the test — check the values');
    } catch { toast('Test failed — check the values'); }
  };

  $('#copyToken', box).onclick = async () => {
    try {
      await navigator.clipboard.writeText(S.settings.captureToken || '');
      toast('Capture token copied');
    } catch { toast('Copy failed — token is in data/db.json'); }
  };

  $('#setTheme', box).onclick = function () {
    this.classList.toggle('on');
    patchSettings({ theme: S.settings.theme === 'light' ? 'dark' : 'light' });
  };
  $('#setCompact', box).onclick = function () {
    this.classList.toggle('on');
    patchSettings({ compact: !S.settings.compact });
  };
  $('#setTagnav', box).onclick = function () {
    this.classList.toggle('on');
    patchSettings({ hideTagNav: !S.settings.hideTagNav });
  };
  $$('[data-font]', box).forEach((b) => b.onclick = () => {
    $$('[data-font]', box).forEach((x) => x.classList.toggle('on', x === b));
    patchSettings({ font: b.dataset.font });
  });
}

// ---- trash
function openTrashModal() {
  const deleted = S.messages.filter((m) => m.deletedAt).sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
  const box = openModal(`
    <h2>Trash</h2>
    <p class="sub">Notes stay here for 30 days, then they're gone for good.</p>
    <div id="trashRows">${deleted.length ? deleted.map((m) => `
      <div class="tagrow" data-id="${m.id}">
        <div style="flex:1;min-width:0">
          <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.text.split('\n')[0] || '(attachment)')}</div>
          <div class="kw">deleted ${fmtTime(m.deletedAt)}</div>
        </div>
        <button class="btn" data-restore>Restore</button>
        <button class="btn danger" data-forever>Delete forever</button>
      </div>`).join('') : '<p class="sub">Trash is empty.</p>'}
    </div>`);
  $$('#trashRows .tagrow', box).forEach((row) => {
    const id = row.dataset.id;
    const m = S.messages.find((x) => x.id === id);
    $('[data-restore]', row).onclick = async () => {
      m.deletedAt = null;
      await api('PATCH', 'messages/' + id, { restore: true });
      openTrashModal();
      renderAll();
      toast('Restored');
    };
    $('[data-forever]', row).onclick = async () => {
      if (!confirm('Delete forever? This cannot be undone.')) return;
      S.messages = S.messages.filter((x) => x.id !== id);
      await api('DELETE', 'messages/' + id); // already trashed → permanent
      openTrashModal();
      toast('Deleted forever');
    };
  });
}

// ---- circulations (scheduled AI runs)
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hourLabel = (h) => `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`;

function openCirculationsModal() {
  const list = S.circulations || [];
  const box = openModal(`
    <h2>Circulations</h2>
    <p class="sub">Scheduled AI runs. Results are pushed to your notification channels; any data changes are listed in the push. Needs the Mac awake at run time.</p>
    <div id="circRows">${list.length ? list.map((c) => `
      <div class="tagrow" data-id="${c.id}">
        <button class="switch ${c.enabled ? 'on' : ''}" data-toggle title="Enable/disable"></button>
        <div style="flex:1;min-width:0;cursor:pointer" data-edit>
          <div class="name">${esc(c.name)}</div>
          <div class="kw">${c.day === 'daily' ? 'Daily' : DAY_LABELS[c.day]} · ${hourLabel(c.hour)}${c.lastRun ? ' · last ran ' + esc(c.lastRun) : ''}${c.lastError ? ` · <span style="color:var(--danger)">failed: ${esc(c.lastError.slice(0, 60))}</span>` : ''}</div>
        </div>
        <button class="btn danger" data-del>✕</button>
      </div>`).join('') : '<p class="sub">No circulations yet.</p>'}
    </div>
    <div class="footrow"><button class="btn primary" id="circAdd">+ Add circulation</button></div>`);
  $$('#circRows .tagrow', box).forEach((row) => {
    const c = S.circulations.find((x) => x.id === row.dataset.id);
    $('[data-toggle]', row).onclick = async () => {
      c.enabled = !c.enabled;
      await api('PATCH', 'circulations/' + c.id, { enabled: c.enabled });
      openCirculationsModal();
    };
    $('[data-edit]', row).onclick = () => openCirculationEditModal(c);
    $('[data-del]', row).onclick = async () => {
      if (!confirm(`Delete "${c.name}"?`)) return;
      S.circulations = S.circulations.filter((x) => x.id !== c.id);
      await api('DELETE', 'circulations/' + c.id);
      openCirculationsModal();
    };
  });
  $('#circAdd', box).onclick = () => openCirculationEditModal(null);
}

function openCirculationEditModal(c) {
  const isNew = !c;
  const box = openModal(`
    <h2>${isNew ? 'New circulation' : 'Edit circulation'}</h2>
    <div class="field"><label>Name</label>
      <input type="text" id="circName" maxlength="60" value="${c ? esc(c.name) : ''}" placeholder="Morning briefing" /></div>
    <div class="field"><label>Prompt</label>
      <textarea id="circPrompt" rows="5" placeholder="What should the AI do on this schedule?">${c ? esc(c.prompt) : ''}</textarea>
      <div class="hint">Tip: end with "Do not make any changes" for read-only runs — otherwise it may edit your data and report the changes.</div></div>
    <div style="display:flex;gap:10px">
      <div class="field" style="flex:1"><label>Cadence</label>
        <select id="circDay">
          <option value="daily" ${!c || c.day === 'daily' ? 'selected' : ''}>Daily</option>
          ${DAY_LABELS.map((d, i) => `<option value="${i}" ${c && c.day === i ? 'selected' : ''}>${d}s</option>`).join('')}
        </select></div>
      <div class="field" style="flex:1"><label>Hour</label>
        <select id="circHour">${[...Array(24).keys()].map((h) => `<option value="${h}" ${(c ? c.hour : 8) === h ? 'selected' : ''}>${hourLabel(h)}</option>`).join('')}</select></div>
    </div>
    <div class="err" id="circErr"></div>
    <div class="footrow"><button class="btn primary" id="circSave">Save</button></div>`);
  $('#circSave', box).onclick = async () => {
    const payload = {
      name: $('#circName', box).value.trim(),
      prompt: $('#circPrompt', box).value.trim(),
      day: $('#circDay', box).value === 'daily' ? 'daily' : +$('#circDay', box).value,
      hour: +$('#circHour', box).value,
    };
    if (!payload.name || !payload.prompt) return showErr(box, 'Name and prompt are required.');
    try {
      if (isNew) {
        const created = await api('POST', 'circulations', payload);
        (S.circulations ||= []).push(created);
      } else {
        const updated = await api('PATCH', 'circulations/' + c.id, payload);
        Object.assign(c, updated);
      }
      openCirculationsModal();
      toast('Circulation saved');
    } catch (err) { showErr(box, err.message); }
  };
}

// ---------------------------------------------------------------- board view

function openBoardSetupModal() {
  if (!S.tags.length) {
    openModal(`<h2>Set up board view</h2><p class="sub">You have no tags yet. Create some tags first.</p>
      <div class="footrow"><button class="btn primary" id="bsAdd">+ Add Tag</button></div>`);
    $('#bsAdd').onclick = () => openTagEditModal(null);
    return;
  }
  const sel = new Set(S.settings.boardColumns || []);
  const box = openModal(`
    <h2>Set up board view</h2>
    <p class="sub">Choose 2–5 tags to become columns.</p>
    <div class="compose-tags" style="margin-bottom:6px">${S.tags.map((t) => `
      <button class="chip ${sel.has(t.id) ? 'on' : ''}" data-id="${t.id}" style="${tagStyle(t)}">
        <span class="swatch"></span>${esc(t.name)}</button>`).join('')}
    </div>
    <div class="err" id="bsErr"></div>
    <div class="footrow"><button class="btn primary" id="bsSave">Open board</button></div>`);
  $$('.chip', box).forEach((c) => c.onclick = () => {
    const id = c.dataset.id;
    if (sel.has(id)) sel.delete(id);
    else if (sel.size >= 5) return showErr(box, 'Choose 2–5 tags to become columns.');
    else sel.add(id);
    c.classList.toggle('on', sel.has(id));
  });
  $('#bsSave', box).onclick = () => {
    if (sel.size < 2) return showErr(box, 'Choose 2–5 tags to become columns.');
    patchSettings({ boardColumns: [...sel] });
    closeModal();
    renderBoard();
  };
}

function renderBoard() {
  const cols = (S.settings.boardColumns || []).map(tagById).filter(Boolean);
  const root = $('#boardCols');
  if (cols.length < 2) {
    root.innerHTML = `<div class="empty" style="grid-column:1/-1"><b>Set up board view</b>Choose 2–5 tags to become columns.<br/><br/><button class="btn primary" id="bdSetup">Set up board</button></div>`;
    $('#bdSetup').onclick = openBoardSetupModal;
    return;
  }
  const msgs = visibleMessages();
  root.innerHTML = cols.map((t) => {
    const cards = msgs.filter((m) => m.tagIds.includes(t.id));
    return `<div class="board-col" data-col="${t.id}" style="${tagStyle(t)}">
      <h3><span class="swatch" style="width:8px;height:8px;border-radius:50%;background:${colorOf(t.color).hex}"></span>
      ${esc(t.name)} <span class="count">${cards.length}</span></h3>
      ${cards.map((m) => cardHtml(m, { draggable: true })).join('') || '<div style="color:var(--text-faint);font-size:12px;padding:8px 6px">No cards yet.</div>'}
    </div>`;
  }).join('');
  hydrateLinkTitles(root);

  // drag & drop between columns
  $$('.card[draggable]', root).forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({
        id: card.dataset.id,
        from: card.closest('.board-col').dataset.col,
      }));
    });
  });
  $$('.board-col', root).forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('dragover');
      let payload;
      try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      const m = S.messages.find((x) => x.id === payload.id);
      const to = col.dataset.col;
      if (!m || payload.from === to) return;
      m.tagIds = [...new Set(m.tagIds.filter((x) => x !== payload.from).concat(to))];
      renderBoard();
      renderTagbar();
      api('PATCH', 'messages/' + m.id, { tagIds: m.tagIds }).catch(() => toast('Failed to save'));
    });
  });
}

// ---------------------------------------------------------------- week view (TeuxDeux style)

function weekStart(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - dow);
  return x;
}

function renderWeek() {
  if (!UI.weekCursor) UI.weekCursor = new Date();
  const start = weekStart(UI.weekCursor);
  const todayK = dayKey(new Date().toISOString());
  const root = $('#weekCols');

  // the week planner only holds tasks
  const tasks = visibleMessages().filter((m) => m.task);
  const byDay = {};
  const inbox = [];
  for (const m of tasks) (m.plannedFor ? (byDay[m.plannedFor] ||= []) : inbox).push(m);

  const days = [...Array(7)].map((_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });

  const end = days[6];
  $('#view-week .title').textContent =
    `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

  root.innerHTML = days.map((d) => {
    const key = dayKey(d.toISOString());
    const cards = byDay[key] || [];
    const cls = key === todayK ? 'today' : (key < todayK ? 'past' : '');
    return `<div class="week-col ${cls}" data-day="${key}">
      <header>
        <div class="dow">${d.toLocaleDateString(undefined, { weekday: 'long' })}</div>
        <div class="date">${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
      </header>
      <input class="w-add" placeholder="+ Add" data-day="${key}" />
      <div class="w-cards">
        ${cards.map((m) => weekCardHtml(m)).join('')}
      </div>
    </div>`;
  }).join('');

  const inboxRoot = $('#weekInbox');
  inboxRoot.innerHTML = `
    <header><b>Inbox</b><span>tasks without a due date — drag onto a day to schedule</span></header>
    <div class="wi-cards">
      <input class="w-add" placeholder="+ Add task" data-day="" />
      ${inbox.map((m) => weekCardHtml(m)).join('')}
    </div>`;

  wireWeekInteractions(root, inboxRoot);
}

function wireWeekInteractions(root, inboxRoot) {
  // quick add (day columns + inbox); empty data-day = no due date yet
  $$('.w-add', $('#view-week')).forEach((inp) => inp.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !inp.value.trim()) return;
    const day = inp.dataset.day;
    try {
      const msg = await api('POST', 'messages', { text: inp.value.trim(), plannedFor: day || null, task: true });
      S.messages.unshift(msg);
      renderWeek();
      renderTagbar();
      $(`.w-add[data-day="${day}"]`, $('#view-week'))?.focus();
    } catch (err) { toast(err.message); }
  }));

  $$('.week-card', $('#view-week')).forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
    });
    $('.wdel', card)?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const m = S.messages.find((x) => x.id === card.dataset.id);
      if (m) m.deletedAt = new Date().toISOString();
      renderWeek();
      api('DELETE', 'messages/' + card.dataset.id).then(() => toast('Moved to trash')).catch(() => toast('Failed to save'));
    });
    card.addEventListener('click', (e) => {
      if (e.target.closest('.wdel') || e.target.closest('.more') || e.target.closest('a') || e.target.closest('.todo-item')) return;
      const m = S.messages.find((x) => x.id === card.dataset.id);
      if (m) openEditModal(m);
    });
  });

  const dropTargets = [...$$('.week-col', root), inboxRoot];
  dropTargets.forEach((zone) => {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const id = e.dataTransfer.getData('text/plain');
      const m = S.messages.find((x) => x.id === id);
      const day = zone.dataset.day || null; // inbox has no data-day → clears due date
      if (!m || m.plannedFor === day) return;
      m.plannedFor = day;
      renderWeek();
      api('PATCH', 'messages/' + m.id, { plannedFor: m.plannedFor }).catch(() => toast('Failed to save'));
    });
  });
}

function weekCardHtml(m) {
  const tags = m.tagIds.map(tagById).filter(Boolean);
  let body;
  if (m.list) {
    body = m.text.split('\n').filter((l) => l.trim()).map((line, i) => {
      const done = (m.checked || []).includes(i);
      return `<div class="todo-item ${done ? 'done' : ''}" data-line="${i}"><span class="box">${done ? '✓' : ''}</span><span class="label">${richText(line)}</span></div>`;
    }).join('');
  } else {
    body = `<div class="todo-item ${m.done ? 'done' : ''}" data-taskdone><span class="box">${m.done ? '✓' : ''}</span><span class="label">${richText(m.text)}</span></div>`;
  }
  return `<div class="week-card card" draggable="true" data-id="${m.id}" style="padding:8px 10px;margin:0">
    <button class="wdel" title="Delete">✕</button>
    <button class="more" data-more title="Options">⋯</button>
    ${body}
    ${m.dueTime || tags.length ? `<div class="meta">
      ${m.dueTime ? `<span class="duechip">${fmtClock(m.dueTime)}</span>` : ''}
      ${tags.map(tagPill).join('')}
    </div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- calendar view

function renderCalendar() {
  if (!UI.calCursor) UI.calCursor = new Date();
  const cur = UI.calCursor;
  const y = cur.getFullYear(), mo = cur.getMonth();
  $('#calMonth').textContent = cur.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const byDay = {};
  for (const m of visibleMessages()) (byDay[dayKey(m.createdAt)] ||= []).push(m);

  const first = new Date(y, mo, 1);
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const startPad = first.getDay();
  const todayKey = dayKey(new Date().toISOString());

  let html = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < startPad; i++) html += `<div class="cal-day blank"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const entries = byDay[key] || [];
    const tagDots = [...new Set(entries.flatMap((m) => m.tagIds))].slice(0, 5)
      .map((tid) => tagById(tid)).filter(Boolean)
      .map((t) => `<i style="background:${colorOf(t.color).hex}"></i>`).join('');
    html += `<button class="cal-day ${key === todayKey ? 'today' : ''} ${key === UI.calSelected ? 'sel' : ''}" data-day="${key}">
      <span class="num">${d}</span>
      ${entries.length ? `<span class="cnt">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</span><span class="dots">${tagDots}</span>` : ''}
    </button>`;
  }
  $('#calGrid').innerHTML = html;

  $$('#calGrid .cal-day[data-day]').forEach((b) => b.onclick = () => {
    UI.calSelected = UI.calSelected === b.dataset.day ? null : b.dataset.day;
    renderCalendar();
  });

  const entriesRoot = $('#calEntries');
  $('#calBody').classList.toggle('split', !!UI.calSelected);
  if (UI.calSelected) {
    const entries = byDay[UI.calSelected] || [];
    const d = new Date(UI.calSelected + 'T12:00');
    entriesRoot.innerHTML = `
      <div class="panel-head">
        <b>${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</b>
        <span style="color:var(--text-faint);font-size:12px">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</span>
        <button class="iconbtn" id="calCloseDay" title="Close">✕</button>
      </div>` +
      (entries.length ? entries.map((m) => cardHtml(m)).join('') : `<div class="empty">No entries on this day.</div>`);
    $('#calCloseDay').onclick = () => { UI.calSelected = null; renderCalendar(); };
  } else {
    entriesRoot.innerHTML = '';
  }
  hydrateLinkTitles(entriesRoot);
}

// ---------------------------------------------------------------- canvas view

function renderCanvas() {
  const wrap = $('#canvasWrap');
  $$('.canvas-card', wrap).forEach((n) => n.remove());
  const cards = S.messages.filter((m) => m.canvas && m.canvas.on);

  let emptyNote = $('#canvasEmpty');
  if (!cards.length) {
    if (!emptyNote) {
      emptyNote = document.createElement('div');
      emptyNote.id = 'canvasEmpty';
      emptyNote.className = 'empty';
      emptyNote.style.cssText = 'position:absolute;top:40%;left:50%;transform:translate(-50%,-50%);border:none';
      emptyNote.innerHTML = `<b>No cards on the canvas yet.</b>Open the card folder and check the cards you want on the free canvas.`;
      wrap.appendChild(emptyNote);
    }
  } else if (emptyNote) emptyNote.remove();

  for (const m of cards) {
    const el = document.createElement('div');
    el.className = 'canvas-card';
    el.dataset.id = m.id;
    el.style.left = (m.canvas.x || 40) + 'px';
    el.style.top = (m.canvas.y || 40) + 'px';
    const img = (m.files || []).find((f) => f.type.startsWith('image/'));
    const tags = m.tagIds.map(tagById).filter(Boolean);
    el.innerHTML = `<div class="text">${richText(m.text)}</div>
      ${img ? `<img src="${esc(img.url)}" alt="" />` : ''}
      ${tags.length ? `<div class="meta">${tags.map(tagPill).join('')}</div>` : ''}`;
    el.title = 'Drag to reposition';
    wrap.appendChild(el);
    makeDraggable(el, m, wrap);
  }
  renderFolder();
}

function makeDraggable(el, m, wrap) {
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('a')) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const origX = m.canvas.x || 40, origY = m.canvas.y || 40;
    el.style.zIndex = 10;
    const move = (ev) => {
      const maxX = wrap.clientWidth - el.offsetWidth - 4;
      const maxY = wrap.clientHeight - el.offsetHeight - 4;
      m.canvas.x = Math.max(4, Math.min(maxX, origX + ev.clientX - startX));
      m.canvas.y = Math.max(4, Math.min(maxY, origY + ev.clientY - startY));
      el.style.left = m.canvas.x + 'px';
      el.style.top = m.canvas.y + 'px';
    };
    const up = () => {
      el.style.zIndex = '';
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      api('PATCH', 'messages/' + m.id, { canvas: m.canvas }).catch(() => {});
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}

const folderState = { search: '', tag: null };

function renderFolder() {
  const list = $('#folderList');
  const tagsRoot = $('#folderTags');
  tagsRoot.innerHTML = S.tags.map((t) =>
    `<button class="chip ${folderState.tag === t.id ? 'on' : ''}" data-id="${t.id}" style="${tagStyle(t)}"><span class="swatch"></span>${esc(t.name)}</button>`).join('');
  $$('.chip', tagsRoot).forEach((c) => c.onclick = () => {
    folderState.tag = folderState.tag === c.dataset.id ? null : c.dataset.id;
    renderFolder();
  });

  let msgs = [...S.messages];
  if (folderState.tag) msgs = msgs.filter((m) => m.tagIds.includes(folderState.tag));
  const q = folderState.search.toLowerCase();
  if (q) msgs = msgs.filter((m) => m.text.toLowerCase().includes(q));

  list.innerHTML = msgs.length ? msgs.map((m) => `
    <div class="f-item ${m.canvas && m.canvas.on ? 'on' : ''}" data-id="${m.id}">
      <span class="box">${m.canvas && m.canvas.on ? '✓' : ''}</span>
      <span class="t">${esc(m.text || (m.files || []).map((f) => f.name).join(', ') || '(empty)')}</span>
    </div>`).join('') : `<p style="color:var(--text-faint);font-size:12px;padding:8px">${q || folderState.tag ? 'No cards match the selected tags.' : 'No cards available.'}</p>`;

  $$('.f-item', list).forEach((row) => row.onclick = () => {
    const m = S.messages.find((x) => x.id === row.dataset.id);
    m.canvas = m.canvas || { on: false, x: 40, y: 40 };
    m.canvas.on = !m.canvas.on;
    if (m.canvas.on) {
      m.canvas.x = 30 + Math.random() * 120;
      m.canvas.y = 30 + Math.random() * 120;
    }
    api('PATCH', 'messages/' + m.id, { canvas: m.canvas }).catch(() => {});
    renderCanvas();
    $('#folder').classList.add('open');
  });
}

// ---------------------------------------------------------------- ask (AI chat)

const CHAT_SUGGESTIONS = [
  "What's due this week?",
  'Move all overdue tasks to tomorrow',
  'Summarize my ideas from the last 7 days',
  'Make a task: pay rent, due Friday 6pm',
  'Which notes have links I saved to read?',
];

UI.chat = []; // {role, content, actions?, error?}

// minimal, safe markdown for assistant replies (escape first, then decorate)
function md(text) {
  let h = esc(text);
  h = h.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, c) => `<pre class="mdcode">${c.trim()}</pre>`);
  h = h.replace(/`([^`\n]+)`/g, '<code class="mdinline">$1</code>');
  h = h.replace(/^#{1,4} (.+)$/gm, '<span class="mdh">$1</span>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  h = h.replace(/^(?:[-*•]|\d+\.) (.+)$/gm, '<span class="mdli">• $1</span>');
  h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/(?<!["'=(\]])\bhttps?:\/\/[^\s<>"')\]]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  return h;
}

function renderAsk() {
  renderAutomations();
  const log = $('#chatLog');
  if (!UI.chat.length) {
    log.innerHTML = `
      <div class="chat-hello">
        <div class="who">sidebrain</div>
        <div class="bubble">I can see everything in your feed — ask me about it, or tell me what to change. I can edit tasks, set due dates, retag, create notes and reminders.</div>
        <div class="chat-suggest">${CHAT_SUGGESTIONS.map((s) => `<button class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      </div>`;
    $$('[data-suggest]', log).forEach((b) => b.onclick = () => {
      $('#chatInput').value = b.dataset.suggest;
      sendChat();
    });
    return;
  }
  log.innerHTML = UI.chat.map((m, i) => `
    <div class="chat-line ${m.role}">
      <span class="who">${m.role === 'user' ? 'you' : 'sidebrain'}</span>
      <div class="bubble ${m.error ? 'err-text' : ''}">${m.pending && !m.content
        ? '<span class="chat-typing">thinking<span>.</span><span>.</span><span>.</span></span>'
        : (m.role === 'assistant' && !m.error ? md(m.content) : richText(m.content)) + (m.pending ? '<span class="stream-cursor"></span>' : '')}</div>
      ${(m.actions || []).map((a) => `<div class="chat-act">✓ ${esc(a)}</div>`).join('')}
      ${m.actions && m.actions.length && m.sourcePrompt ? `<button class="chip save-auto" data-chatidx="${i}">💾 Save as automation</button>` : ''}
    </div>`).join('');
  $$('.save-auto', log).forEach((b) => b.onclick = () => openSaveAutomationModal(UI.chat[+b.dataset.chatidx].sourcePrompt));
  log.scrollTop = log.scrollHeight;
}

function renderAutomations() {
  const root = $('#chatAutos');
  root.innerHTML = (S.automations || []).map((a) => `
    <span class="chip auto-chip" data-id="${a.id}" title="${esc(a.prompt)}">
      <button class="run" data-run>▶ ${esc(a.name)}</button><button class="x" data-del title="Delete automation">✕</button>
    </span>`).join('');
  $$('.auto-chip', root).forEach((chipEl) => {
    const auto = (S.automations || []).find((a) => a.id === chipEl.dataset.id);
    $('[data-run]', chipEl).onclick = () => {
      $('#chatInput').value = auto.prompt;
      sendChat();
    };
    $('[data-del]', chipEl).onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete automation "${auto.name}"?`)) return;
      S.automations = S.automations.filter((a) => a.id !== auto.id);
      renderAutomations();
      api('DELETE', 'automations/' + auto.id).catch(() => toast('Failed to delete'));
    };
  });
}

function openSaveAutomationModal(prompt) {
  const box = openModal(`
    <h2>Save as automation</h2>
    <p class="sub">One tap re-runs this instruction against your latest data — it redoes the intent, not the literal old edits.</p>
    <div class="field"><label>Button name</label>
      <input type="text" id="autoName" maxlength="40" value="${esc(prompt.slice(0, 32))}" /></div>
    <div class="field"><label>Instruction</label>
      <textarea id="autoPrompt" rows="3">${esc(prompt)}</textarea></div>
    <div class="err" id="autoErr"></div>
    <div class="footrow"><button class="btn primary" id="autoSave">Save</button></div>`);
  $('#autoName', box).focus();
  $('#autoSave', box).onclick = async () => {
    const name = $('#autoName', box).value.trim();
    const p = $('#autoPrompt', box).value.trim();
    if (!name || !p) return showErr(box, 'Name and instruction are both required.');
    try {
      const auto = await api('POST', 'automations', { name, prompt: p });
      (S.automations ||= []).push(auto);
      closeModal();
      renderAutomations();
      toast('Automation saved — it lives at the top of Ask');
    } catch (err) { showErr(box, err.message); }
  };
}

async function sendChat() {
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text || sendChat._busy) return;
  sendChat._busy = true;
  input.value = '';
  input.style.height = 'auto';
  UI.chat.push({ role: 'user', content: text });
  const pending = { role: 'assistant', content: '', pending: true, sourcePrompt: text };
  UI.chat.push(pending);
  renderAsk();
  try {
    const history = UI.chat.filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, content: m.content }));
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error('Chat request failed (' + res.status + ')');

    // consume the SSE stream: content deltas render live, actions appear as they apply
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    pending.actions = [];
    let finished = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.delta) { pending.content += ev.delta; renderAsk(); }
        if (ev.action) { pending.actions.push(ev.action); renderAsk(); }
        if (ev.error) throw new Error(ev.error);
        if (ev.done) {
          pending.content = ev.reply || pending.content || '(no reply)';
          pending.actions = ev.actions || pending.actions;
          finished = true;
        }
      }
    }
    if (!finished && !pending.content) throw new Error('The AI stream ended unexpectedly.');
    pending.pending = false;
    if (pending.actions.length) {
      await loadState();
      renderTagbar();
    }
  } catch (err) {
    pending.pending = false;
    pending.error = true;
    pending.content = err.message;
  }
  sendChat._busy = false;
  renderAsk();
}

// ---------------------------------------------------------------- lightbox

function openLightbox(urls, i) {
  UI.lightbox = { urls, i };
  $('#lightboxImg').src = urls[i];
  $('#lightbox').classList.add('open');
  const multi = urls.length > 1;
  $('.lb-prev').style.display = multi ? '' : 'none';
  $('.lb-next').style.display = multi ? '' : 'none';
}
function closeLightbox() { $('#lightbox').classList.remove('open'); }
function stepLightbox(d) {
  const { urls } = UI.lightbox;
  UI.lightbox.i = (UI.lightbox.i + d + urls.length) % urls.length;
  $('#lightboxImg').src = urls[UI.lightbox.i];
}

// ---------------------------------------------------------------- views

function setView(v) {
  UI.view = v;
  for (const name of ['feed', 'week', 'calendar', 'ask']) {
    $('#view-' + name).hidden = name !== v;
  }
  $$('#viewSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  renderCurrentView();
}

function renderCurrentView() {
  if (UI.view === 'feed') renderFeed();
  else if (UI.view === 'week') renderWeek();
  else if (UI.view === 'calendar') renderCalendar();
  else if (UI.view === 'ask') renderAsk();
}

function renderAll() {
  renderTagbar();
  renderCurrentView();
  renderReminderDot();
}

// ---------------------------------------------------------------- boot

async function boot() {
  await loadState();
  applySettings();
  initComposer();
  renderAll();

  // header
  $$('#viewSwitch button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.goto)));
  $('#btnSettings').addEventListener('click', openSettingsModal);
  $('#btnReminders').addEventListener('click', openRemindersModal);
  $('#btnChangeCols').addEventListener('click', openBoardSetupModal);
  $('#weekPrev').addEventListener('click', () => { UI.weekCursor.setDate(UI.weekCursor.getDate() - 7); renderWeek(); });
  $('#weekNext').addEventListener('click', () => { UI.weekCursor.setDate(UI.weekCursor.getDate() + 7); renderWeek(); });
  $('#weekToday').addEventListener('click', () => { UI.weekCursor = new Date(); renderWeek(); });
  $('#calPrev').addEventListener('click', () => { UI.calCursor.setMonth(UI.calCursor.getMonth() - 1); renderCalendar(); });
  $('#calNext').addEventListener('click', () => { UI.calCursor.setMonth(UI.calCursor.getMonth() + 1); renderCalendar(); });
  $('#btnFolder').addEventListener('click', () => { $('#folder').classList.toggle('open'); renderFolder(); });
  $('#folderClose').addEventListener('click', () => $('#folder').classList.remove('open'));
  $('#folderSearch').addEventListener('input', (e) => { folderState.search = e.target.value; renderFolder(); });

  // search
  const search = $('#search');
  search.addEventListener('input', () => {
    UI.search = search.value;
    $('#searchClear').style.display = search.value ? 'block' : 'none';
    renderCurrentView();
  });
  $('#searchClear').addEventListener('click', () => { search.value = ''; UI.search = ''; $('#searchClear').style.display = 'none'; renderCurrentView(); });

  // date filter (created / due)
  $('#btnFilter').addEventListener('click', () => {
    $('#filterbar').hidden = !$('#filterbar').hidden;
    if (!$('#filterbar').hidden) $('#filterDate').focus();
  });
  const applyDateFilter = () => {
    UI.dateFilter = { field: $('#filterField').value, date: $('#filterDate').value };
    $('#btnFilter').classList.toggle('active', !!UI.dateFilter.date);
    renderCurrentView();
  };
  $('#filterField').addEventListener('change', applyDateFilter);
  $('#filterDate').addEventListener('input', applyDateFilter);
  $('#filterClear').addEventListener('click', () => {
    $('#filterDate').value = '';
    applyDateFilter();
    $('#filterbar').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      e.preventDefault();
      search.focus();
    }
  });

  // lightbox
  $('.lb-close').addEventListener('click', closeLightbox);
  $('.lb-prev').addEventListener('click', () => stepLightbox(-1));
  $('.lb-next').addEventListener('click', () => stepLightbox(1));
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });

  // refresh: manual button + automatic when the PWA returns to foreground
  const doRefresh = async (quiet) => {
    try {
      await loadState();
      renderAll();
      if (!quiet) toast('Refreshed');
    } catch { if (!quiet) toast('Refresh failed'); }
  };
  $('#btnRefresh').addEventListener('click', () => doRefresh(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') doRefresh(true);
  });

  // ask chat
  const chatInput = $('#chatInput');
  $('#chatReset').addEventListener('click', () => {
    UI.chat = [];
    renderAsk();
  });
  $('#chatSend').addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });

  // reminders heartbeat
  checkDueReminders();
  setInterval(checkDueReminders, 30000);

  setView('feed');
}

boot();
