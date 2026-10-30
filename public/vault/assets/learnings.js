(function () {
  const state = {
    loaded: false,
    loading: false,
    authenticated: false,
    entries: [],
    search: '',
    filter: 'all',
    pendingAction: null,
    editingEntry: null,
    deletingEntryId: null,
  };

  const STATUS_META = {
    saved: { label: 'Saved', className: 'lh-status-saved' },
    watched: { label: 'Watched', className: 'lh-status-watched' },
    skimmed: { label: 'Skimmed', className: 'lh-status-skimmed' },
  };

  const STATUS_CYCLE = {
    saved: 'watched',
    watched: 'skimmed',
    skimmed: 'saved',
  };

  const CATEGORY_META = {
    ai: { label: 'AI' },
    others: { label: 'Others' },
  };

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function appRoot() {
    return document.getElementById('learnings-app');
  }

  function ensureUi() {
    const root = appRoot();
    if (!root || root.dataset.ready === 'true') return;
    root.dataset.ready = 'true';
    root.innerHTML = `
      <div class="lh-shell">
        <div class="lh-toolbar">
          <div class="lh-toolbar-top">
            <div>
              <h2>Cardlake</h2>
              <p>Sign in to edit.</p>
            </div>
            <div class="lh-auth-row" id="lh-auth-row"></div>
          </div>
          <label class="lh-search">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input id="lh-search-input" type="search" placeholder="Search resources, notes, or URLs">
          </label>
          <div class="lh-filter-pills" id="lh-filter-pills"></div>
        </div>
        <div id="lh-content" class="lh-loading">Loading learnings…</div>
      </div>
      <div class="lh-modal" id="lh-editor-modal">
        <div class="lh-modal-card">
          <div class="lh-modal-handle"></div>
          <div>
            <h3 id="lh-editor-title">Add resource</h3>
            <p>Create or update a learning entry.</p>
          </div>
          <form id="lh-editor-form" class="lh-form">
            <label class="lh-field">
              <span>Title</span>
              <input type="text" name="title" maxlength="300" required>
            </label>
            <label class="lh-field">
              <span>URL</span>
              <input type="url" name="url" placeholder="https://...">
            </label>
            <div class="lh-field-row">
              <label class="lh-field">
                <span>Status</span>
                <select name="status">
                  <option value="saved">Saved</option>
                  <option value="watched">Watched</option>
                  <option value="skimmed">Skimmed</option>
                </select>
              </label>
              <label class="lh-field">
                <span>Category</span>
                <select name="category">
                  <option value="ai">AI</option>
                  <option value="others">Others</option>
                </select>
              </label>
            </div>
            <label class="lh-field">
              <span>Notes</span>
              <textarea name="notes" placeholder="Why it matters, follow-up, next action..."></textarea>
            </label>
            <div class="lh-modal-actions">
              <button type="button" class="lh-btn" data-close="lh-editor-modal">Cancel</button>
              <button type="submit" class="lh-btn lh-btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>
      <div class="lh-toast-stack" id="lh-toast-stack"></div>
    `;

    root.querySelector('#lh-search-input').addEventListener('input', event => {
      state.search = event.target.value;
      renderEntries();
    });

    root.querySelector('#lh-editor-form').addEventListener('submit', submitEditor);
    root.querySelectorAll('[data-close]').forEach(button => {
      button.addEventListener('click', () => closeModal(button.dataset.close));
    });
    root.querySelectorAll('.lh-modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal.id);
      });
    });
  }

  function renderToolbar() {
    const authRow = document.getElementById('lh-auth-row');
    const pills = document.getElementById('lh-filter-pills');
    if (!authRow || !pills) return;

    authRow.innerHTML = state.authenticated
      ? `
          <button class="lh-btn lh-btn-primary" id="lh-add-btn">＋ Add</button>
          <button class="lh-btn" id="lh-logout-btn">Log out</button>
        `
      : '<button class="lh-btn lh-btn-primary" id="lh-add-btn">＋ Add</button><button class="lh-btn" id="lh-login-btn">Sign in</button>';

    pills.innerHTML = `
      <button class="lh-pill ${state.filter === 'all' ? 'active' : ''}" data-filter="all">All</button>
      <button class="lh-pill ${state.filter === 'saved' ? 'active' : ''}" data-filter="saved">Saved</button>
      <button class="lh-pill ${state.filter === 'watched' ? 'active' : ''}" data-filter="watched">Watched</button>
      <button class="lh-pill ${state.filter === 'skimmed' ? 'active' : ''}" data-filter="skimmed">Skimmed</button>
    `;

    const loginBtn = document.getElementById('lh-login-btn');
    const addBtn = document.getElementById('lh-add-btn');
    const logoutBtn = document.getElementById('lh-logout-btn');

    if (loginBtn) loginBtn.addEventListener('click', () => openLoginModal());
    if (addBtn) addBtn.addEventListener('click', () => requireSignIn(() => openEditor()));
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await fetchJson('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        state.authenticated = false;
        toast('Logged out');
        renderToolbar();
        renderEntries();
      });
    }

    pills.querySelectorAll('[data-filter]').forEach(button => {
      button.addEventListener('click', () => {
        state.filter = button.dataset.filter;
        renderToolbar();
        renderEntries();
      });
    });
  }

  function filteredEntries() {
    const query = state.search.trim().toLowerCase();
    return state.entries.filter(entry => {
      if (state.filter !== 'all' && entry.status !== state.filter) return false;
      if (!query) return true;
      return [entry.title, entry.url, entry.notes, CATEGORY_META[entry.category].label, STATUS_META[entry.status].label]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }

  function renderEntries() {
    const container = document.getElementById('lh-content');
    if (!container) return;

    const entries = filteredEntries();
    const byCategory = {
      ai: entries.filter(entry => entry.category === 'ai'),
      others: entries.filter(entry => entry.category === 'others'),
    };

    if (!entries.length) {
      container.innerHTML = '<div class="lh-empty">No learnings match your current search or filter.</div>';
      return;
    }

    container.innerHTML = ['ai', 'others'].map(category => {
      const categoryEntries = byCategory[category];
      return `
        <section class="lh-section">
          <div class="lh-section-head">
            <h3>${CATEGORY_META[category].label}</h3>
            <span class="lh-meta">${categoryEntries.length} item${categoryEntries.length === 1 ? '' : 's'}</span>
          </div>
          ${categoryEntries.length ? `<div class="lh-grid">${categoryEntries.map(renderCard).join('')}</div>` : '<div class="lh-empty">No items in this section.</div>'}
        </section>
      `;
    }).join('');

    container.querySelectorAll('[data-edit-id]').forEach(button => {
      button.addEventListener('click', () => {
        const entry = state.entries.find(item => item.id === button.dataset.editId);
        requireSignIn(() => openEditor(entry));
      });
    });

    container.querySelectorAll('[data-delete-id]').forEach(button => {
      button.addEventListener('click', () => {
        requireSignIn(() => {
          state.deletingEntryId = button.dataset.deleteId;
          renderEntries();
        });
      });
    });

    container.querySelectorAll('[data-confirm-delete-id]').forEach(button => {
      button.addEventListener('click', () => deleteEntry(button.dataset.confirmDeleteId));
    });

    container.querySelectorAll('[data-cancel-delete]').forEach(button => {
      button.addEventListener('click', () => {
        state.deletingEntryId = null;
        renderEntries();
      });
    });

    container.querySelectorAll('[data-move-id]').forEach(button => {
      button.addEventListener('click', () => requireSignIn(() => moveEntry(button.dataset.moveId, button.dataset.direction)));
    });

    container.querySelectorAll('[data-status-id]').forEach(button => {
      button.addEventListener('click', () => requireSignIn(() => switchStatus(button.dataset.statusId)));
    });
  }

  function renderCard(entry) {
    const status = STATUS_META[entry.status];
    // Only a web link becomes clickable; an older javascript: or data: value
    // is shown as text so a click can't run it.
    const isWebLink = /^https?:\/\//i.test(String(entry.url || '').trim());
    const urlHtml = !entry.url ? '<span class="lh-meta">No URL</span>'
      : isWebLink ? `<a href="${escapeHtml(entry.url.trim())}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.url)}</a>`
      : `<span class="lh-meta">${escapeHtml(entry.url)}</span>`;
    const statusHtml = state.authenticated
      ? `<button type="button" class="lh-status ${status.className}" data-status-id="${entry.id}" title="Click to cycle status">${status.label}</button>`
      : `<span class="lh-status ${status.className}">${status.label}</span>`;
    const adminControls = `
      <div class="lh-card-actions">
        <button class="lh-btn" data-edit-id="${entry.id}" aria-label="Edit learning entry" title="Edit learning entry"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        <button class="lh-btn" data-move-id="${entry.id}" data-direction="up">↑</button>
        <button class="lh-btn" data-move-id="${entry.id}" data-direction="down">↓</button>
        ${state.deletingEntryId === entry.id
          ? `<span class="lh-delete-confirm" role="group" aria-label="Confirm deletion">Delete? <button type="button" class="lh-btn lh-btn-danger" data-confirm-delete-id="${entry.id}">Delete</button><button type="button" class="lh-btn" data-cancel-delete>Cancel</button></span>`
          : `<button type="button" class="lh-btn lh-btn-danger" data-delete-id="${entry.id}" aria-label="Delete learning entry" title="Delete learning entry"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>`}
      </div>
    `;

    return `
      <article class="lh-card">
        <div class="lh-card-top">
          <div>
            <h4>${escapeHtml(entry.title)}</h4>
            <div class="lh-meta">${urlHtml}</div>
          </div>
          ${statusHtml}
        </div>
        <div class="lh-notes">${escapeHtml(entry.notes || 'No notes yet.')}</div>
        ${adminControls}
      </article>
    `;
  }

  function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
      modal.classList.remove('open');
      document.body.style.overflow = '';
    }
  }

  // Same sign-in as the rest of the vault (vault.js).
  function openLoginModal() {
    window.Cardle.showLogin(() => {
      state.authenticated = true;
      renderToolbar();
      renderEntries();
      toast('Signed in');
      if (state.pendingAction) {
        const action = state.pendingAction;
        state.pendingAction = null;
        action();
      }
    });
  }

  function openEditor(entry) {
    state.editingEntry = entry || null;
    const form = document.getElementById('lh-editor-form');
    const title = document.getElementById('lh-editor-title');
    title.textContent = entry ? 'Edit resource' : 'Add resource';
    form.title.value = entry ? entry.title : '';
    form.url.value = entry ? entry.url : '';
    form.notes.value = entry ? entry.notes : '';
    form.status.value = entry ? entry.status : 'saved';
    form.category.value = entry ? entry.category : 'ai';
    openModal('lh-editor-modal');
  }

  function toast(message) {
    const stack = document.getElementById('lh-toast-stack');
    if (!stack) return;
    const node = document.createElement('div');
    node.className = 'lh-toast';
    node.textContent = message;
    stack.appendChild(node);
    window.setTimeout(() => node.remove(), 3200);
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      const message = payload && payload.error ? payload.error : `Request failed with status ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  async function loadSession() {
    const payload = await fetchJson('/api/auth/session', { credentials: 'same-origin' });
    state.authenticated = Boolean(payload.authenticated);
    renderToolbar();
  }

  async function loadEntries(force) {
    if (state.loading) return;
    if (state.loaded && !force) return;
    state.loading = true;
    const content = document.getElementById('lh-content');
    if (content) content.innerHTML = '<div class="lh-loading">Loading learnings…</div>';
    try {
      const payload = await fetchJson('/api/learnings');
      state.entries = payload.entries || [];
      state.loaded = true;
      renderEntries();
    } catch (error) {
      if (content) {
        content.innerHTML = `<div class="lh-empty">Could not load Cardlake. ${escapeHtml(error.message)}</div>`;
      }
      toast(error.message);
    } finally {
      state.loading = false;
    }
  }

  function requireSignIn(callback) {
    if (state.authenticated) {
      callback();
      return;
    }
    state.pendingAction = callback;
    openLoginModal();
  }

  async function submitEditor(event) {
    event.preventDefault();
    const form = event.target;
    const payload = {
      title: form.title.value.trim(),
      url: form.url.value.trim(),
      notes: form.notes.value.trim(),
      status: form.status.value,
      category: form.category.value,
    };

    if (!payload.title) {
      toast('Title is required');
      return;
    }

    try {
      if (state.editingEntry) {
        await fetchJson(`/api/learnings/${state.editingEntry.id}`, {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Entry updated');
      } else {
        await fetchJson('/api/learnings', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Entry created');
      }
      closeModal('lh-editor-modal');
      form.reset();
      state.editingEntry = null;
      await loadEntries(true);
    } catch (error) {
      toast(error.message);
    }
  }

  async function switchStatus(id) {
    const entry = state.entries.find(item => item.id === id);
    if (!entry) return;

    const nextStatus = STATUS_CYCLE[entry.status] || 'saved';

    try {
      await fetchJson(`/api/learnings/${id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      state.entries = state.entries.map(item => (
        item.id === id ? { ...item, status: nextStatus } : item
      ));
      renderEntries();
      toast(`Status updated to ${STATUS_META[nextStatus].label}`);
    } catch (error) {
      toast(error.message);
    }
  }

  async function deleteEntry(id) {
    try {
      await fetchJson(`/api/learnings/${id}`, { method: 'DELETE', credentials: 'same-origin' });
      state.entries = state.entries.filter(entry => entry.id !== id);
      state.deletingEntryId = null;
      renderEntries();
      toast('Entry deleted');
    } catch (error) {
      toast(error.message);
    }
  }

  async function moveEntry(id, direction) {
    const entry = state.entries.find(item => item.id === id);
    if (!entry) return;

    const siblings = state.entries
      .filter(item => item.category === entry.category)
      .sort((a, b) => a.sort_order - b.sort_order);
    const index = siblings.findIndex(item => item.id === id);
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= siblings.length) return;

    const reorderedIds = siblings.map(item => item.id);
    [reorderedIds[index], reorderedIds[swapIndex]] = [reorderedIds[swapIndex], reorderedIds[index]];

    try {
      await fetchJson('/api/learnings/reorder', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: reorderedIds }),
      });
      toast('Order updated');
      await loadEntries(true);
    } catch (error) {
      toast(error.message);
    }
  }

  async function ensureLoaded(force) {
    ensureUi();
    renderToolbar();
    try {
      await loadSession();
      await loadEntries(force);
    } catch (error) {
      toast(error.message);
    }
  }

  window.CardleLearningsApp = { ensureLoaded, refresh: () => ensureLoaded(true) };

  // A login in any Cardlake tab sets the same cookie; reflect it immediately here.
  window.addEventListener('cardle:auth-changed', () => ensureLoaded(true));

  document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('page-learnings')) {
      ensureUi();
      const page = document.getElementById('page-learnings');
      if (page && page.classList.contains('active')) {
        ensureLoaded();
      }
    }
  });
})();
