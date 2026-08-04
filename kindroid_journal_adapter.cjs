'use strict';

const UI_MAP_ERROR = 'KINDROID JOURNAL UI MAP NEEDS UPDATE';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class JournalStageError extends Error {
  constructor(stage, message, diagnostics = {}) {
    super(message);
    this.name = 'JournalStageError';
    this.stage = stage;
    this.diagnostics = diagnostics;
  }
}

class KindroidJournalAdapter {
  constructor(window, options = {}) {
    this.window = window;
    this.progress = options.progress || (() => {});
    this.cancelled = options.cancelled || (() => false);
  }

  async run(source) {
    if (!this.window || this.window.isDestroyed()) throw new JournalStageError('window', 'Journal window is unavailable.');
    return this.window.webContents.executeJavaScript(`(${source})()`);
  }

  report(stage, detail = '') { this.progress(stage, detail); }

  async waitFor(stage, conditionSource, { timeout = 15000, interval = 200, message } = {}) {
    const result = await this.run(`async () => {
      const deadline = Date.now() + ${timeout};
      let last = null;
      while (Date.now() < deadline) {
        try { last = await (${conditionSource})(); } catch (error) { last = { conditionError: error.message }; }
        if (last && (typeof last !== 'object' || last.ready !== false)) return { ok: true, value: last };
        await new Promise(resolve => setTimeout(resolve, ${interval}));
      }
      return { ok: false, last };
    }`);
    if (!result?.ok) throw new JournalStageError(stage, message || `Timed out during ${stage}.`, result?.last || {});
    return result.value;
  }

  async diagnostics() {
    try {
      return await this.run(`() => {
        const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
        const controls = [...document.querySelectorAll('button,[role="radio"],[role="tab"],[role="button"]')];
        return {
          url: location.href, title: document.title,
          buttonsFound: controls.length,
          visibleButtons: controls.filter(node => node.getClientRects().length).slice(0, 30).map(node => norm(node.getAttribute('aria-label') || node.textContent)).filter(Boolean),
          globalSelected: controls.some(node => /^(global)$/i.test(norm(node.getAttribute('aria-label') || node.textContent)) && ['true','active'].includes(node.getAttribute('aria-checked') || node.getAttribute('aria-selected') || node.getAttribute('data-state'))),
          rowsFound: document.querySelectorAll('[data-journal-id],[data-entry-id],[role="listitem"]').length,
          editorVisible: Boolean(document.querySelector('textarea, [contenteditable="true"]'))
        };
      }`);
    } catch (error) { return { url: this.window?.webContents?.getURL?.() || '', diagnosticError: error.message }; }
  }

  async openJournalPage(aiId) {
    const id = String(aiId || '').trim();
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) throw new JournalStageError('resolving-ai-id', 'NO VALID DIRECTORY AI ID');
    this.report('waiting_for_journal_page');
    await this.window.loadURL(`https://kindroid.ai/v2/kin-settings/${encodeURIComponent(id)}/?tab=journal`);
    await this.waitFor('waiting-for-journal-shell', `() => {
      const text = document.body?.innerText || '';
      const ready = document.readyState !== 'loading' && (/journal/i.test(text) || document.querySelector('[role="radio"],[role="tab"],textarea'));
      return ready ? { ready: true, url: location.href } : { ready: false, url: location.href, documentState: document.readyState };
    }`, { timeout: 20000, message: 'Timed out waiting for the Kindroid journal page.' });
    const url = this.window.webContents.getURL();
    if (/login|signin|auth/i.test(url)) throw new JournalStageError('authentication', 'LOGIN REQUIRED', { url });
  }

  async selectJournalScope(scope) {
    const wanted = scope === 'global' ? 'Global' : 'Personal';
    this.report('selecting_scope', wanted);
    const located = await this.waitFor('locating-global-control', `() => {
      const norm = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const controls = [...document.querySelectorAll('button,[role="radio"],[role="tab"],[role="button"]')];
      const control = controls.find(node => norm(node.getAttribute('aria-label')) === ${JSON.stringify(wanted.toLowerCase())} || norm(node.textContent) === ${JSON.stringify(wanted.toLowerCase())});
      if (!control) return { ready: false, buttonsFound: controls.length };
      if (!['true','active'].includes(control.getAttribute('aria-checked') || control.getAttribute('aria-selected') || control.getAttribute('data-state'))) control.click();
      return { ready: true };
    }`, { message: `${wanted} journal control was not found.` });
    if (!located) throw new JournalStageError('locating-global-control', `${wanted} journal control was not found.`);
    await this.waitFor('activating-global-control', `() => {
      const norm = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const control = [...document.querySelectorAll('button,[role="radio"],[role="tab"],[role="button"]')].find(node => norm(node.getAttribute('aria-label')) === ${JSON.stringify(wanted.toLowerCase())} || norm(node.textContent) === ${JSON.stringify(wanted.toLowerCase())});
      if (!control) return { ready: false, controlMissing: true };
      const state = control.getAttribute('aria-checked') || control.getAttribute('aria-selected') || control.getAttribute('data-state');
      const activeClass = /(^|\\s)(active|selected)(\\s|$)/i.test(control.className || '');
      return (state === 'true' || state === 'active' || activeClass) ? { ready: true, selectedState: state || 'class' } : { ready: false, selectedState: state };
    }`, { message: `${wanted} journal control did not become active.` });
  }

  async waitForJournalList() {
    this.report('waiting_for_global_list');
    return this.waitFor('waiting-for-global-list', `() => {
      const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = node => Boolean(node && node.getClientRects().length);
      const rows = [...document.querySelectorAll('button[class*="journal-sheet-v2_entry-row"]')].filter(button => visible(button)
        && button.querySelector('[class*="journal-sheet-v2_entry-title"]')
        && button.querySelector('[class*="journal-sheet-v2_entry-description"]'));
      const emptyState = [...document.querySelectorAll('p,div,[role="status"]')].find(node => visible(node) && node.children.length < 4
        && /no .*journal|haven.t created any .*journal/i.test(norm(node.textContent)));
      if (rows.length) return { ready:true, empty:false, rowCount:rows.length };
      if (emptyState) return { ready:true, empty:true, rowCount:0 };
      return { ready:false, empty:false, rowCount:0 };
    }`, { timeout: 20000, message: 'Timed out waiting for confirmed Kindroid journal rows or the journal empty state.' });
  }

  async scanJournalIndex() {
    const rows = await this.run(`async () => {
      const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = node => Boolean(node && node.getClientRects().length);
      const findRows = () => [...document.querySelectorAll('button[class*="journal-sheet-v2_entry-row"]')].filter(button => visible(button)
        && button.querySelector('[class*="journal-sheet-v2_entry-title"]')
        && button.querySelector('[class*="journal-sheet-v2_entry-description"]'));
      const firstRow = findRows()[0];
      let container = firstRow?.parentElement;
      while (container && container !== document.body && container.scrollHeight <= container.clientHeight + 20) container = container.parentElement;
      container = container || firstRow?.closest('main,section') || document.scrollingElement;
      const found = new Map(); let stable = 0; let previous = -1;
      while (stable < 4) {
        findRows().forEach(button => {
          const title = norm(button.querySelector('[class*="journal-sheet-v2_entry-title"]')?.textContent);
          const preview = norm(button.querySelector('[class*="journal-sheet-v2_entry-description"]')?.textContent);
          if (!title) return;
          const remoteId = button.dataset.journalId || button.dataset.entryId || '';
          const key = remoteId || title + '\\n' + preview;
          if (!found.has(key)) found.set(key, { index:found.size, title, preview, remote_id:remoteId, handle:{ remote_id:remoteId, title, preview } });
        });
        stable = found.size === previous ? stable + 1 : 0; previous = found.size;
        const before = container.scrollTop;
        container.scrollTop = Math.min(container.scrollHeight, before + Math.max(250, container.clientHeight * .75));
        await new Promise(resolve => setTimeout(resolve, 250));
        if (container.scrollTop === before) stable += 1;
      }
      container.scrollTop = 0; return [...found.values()];
    }`);
    this.report('rows_detected', String(rows.length));
    return rows;
  }

  async openJournalEntry(handle) {
    const id = String(handle?.remote_id || ''); const title = String(handle?.title || '').trim(); const preview = String(handle?.preview || '').trim();
    // Kindroid virtualizes long journal lists. A row captured while scrolling is
    // commonly no longer mounted when extraction begins, so reacquire it while
    // scrolling rather than treating the stale visible-text handle as missing.
    const clicked = await this.run(`async () => {
      const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = node => Boolean(node && node.getClientRects().length);
      const rows = () => [...document.querySelectorAll('button[class*="journal-sheet-v2_entry-row"]')].filter(button => visible(button)
        && button.querySelector('[class*="journal-sheet-v2_entry-title"]')
        && button.querySelector('[class*="journal-sheet-v2_entry-description"]'));
      const find = () => rows().find(button => {
        const rowId = button.dataset.journalId || button.dataset.entryId || '';
        const rowTitle = norm(button.querySelector('[class*="journal-sheet-v2_entry-title"]')?.textContent);
        const rowPreview = norm(button.querySelector('[class*="journal-sheet-v2_entry-description"]')?.textContent);
        return (${JSON.stringify(id)} && rowId === ${JSON.stringify(id)}) || (rowTitle === ${JSON.stringify(title)} && rowPreview === ${JSON.stringify(preview)});
      });
      const firstRow = rows()[0];
      let container = firstRow?.parentElement;
      while (container && container !== document.body && container.scrollHeight <= container.clientHeight + 20) container = container.parentElement;
      container = container || firstRow?.closest('main,section') || document.scrollingElement;
      container.scrollTop = 0;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const node = find(); if (node) { node.scrollIntoView({ block:'center', behavior:'instant' }); node.click(); return true; }
        const before = container.scrollTop; container.scrollTop = Math.min(container.scrollHeight, before + Math.max(200, container.clientHeight * .7));
        await new Promise(resolve => setTimeout(resolve, 100));
        if (container.scrollTop === before && attempt > 2) break;
      }
      container.scrollTop = 0; return false;
    }`);
    if (!clicked) throw new JournalStageError('opening-entry', 'The expected Kindroid journal row could not be reacquired.', { handle });
    await this.waitFor('waiting-for-editor', `() => {
      const description = document.querySelector('textarea[maxlength="500"]');
      const save = [...document.querySelectorAll('button')].find(button => String(button.textContent || '').trim() === 'Save changes');
      return description && save ? { ready:true } : { ready:false };
    }`, { message: 'The selected journal entry did not open its editor.' });
  }

  async readJournalEditor(position = 0, fallback = {}, scope = 'global') {
    const data = await this.run(`() => {
      const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = node => Boolean(node && node.getClientRects().length);
      const fieldNear = pattern => {
        const label = [...document.querySelectorAll('label,p,span,div')].find(node => node.children.length < 4 && pattern.test(norm(node.textContent)));
        const root = label?.closest('label') || label?.parentElement; return root?.querySelector('textarea,[contenteditable="true"],input') || null;
      };
      const descriptionField = fieldNear(/^(journal (?:entry|description)|description)$/i)
        || [...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible).sort((a,b) => (b.maxLength || b.innerText?.length || 0) - (a.maxLength || a.innerText?.length || 0))[0];
      if (!descriptionField) return null;
      const remove = [...document.querySelectorAll('button[aria-label^="Remove" i]')];
      let keywords = remove.map(node => norm((node.getAttribute('aria-label') || '').replace(/^Remove\\s*/i,''))).filter(Boolean);
      if (!keywords.length) keywords = [...document.querySelectorAll('[data-keyword],input[type="hidden"],input[placeholder*="keyword" i],input[placeholder*="keyphrase" i]')].map(node => norm(node.dataset.keyword || node.value || node.getAttribute('value') || node.textContent)).filter(Boolean);
      const params = new URL(location.href).searchParams;
      const remoteId = params.get('journalId') || params.get('journal_id') || params.get('entryId') || document.querySelector('[data-journal-id],[data-entry-id]')?.dataset.journalId || document.querySelector('[data-entry-id]')?.dataset.entryId || '';
      return { keywords, description: descriptionField.value || descriptionField.getAttribute('value') || descriptionField.innerText || descriptionField.textContent || '', remote_id: remoteId };
    }`);
    if (!data) throw new JournalStageError('extracting-entry', UI_MAP_ERROR);
    const keywords = [...new Map((data.keywords || []).map(value => [String(value).trim().toLowerCase(), String(value).trim()])).values()].filter(Boolean);
    return { remote_id: data.remote_id || fallback.remote_id || '', scope, title: keywords[0] || fallback.title || '', keywords, description: String(data.description || '').trim(), created_at: null, updated_at: null, position };
  }

  async returnToJournalList() {
    const clicked = await this.run(`() => {
      const visible = node => Boolean(node && node.getClientRects().length);
      const node = [...document.querySelectorAll('button[aria-label="Back"]')].filter(visible)
        .find(button => button.closest('[class*="journal-sheet"],main,section'));
      if (!node) return false;
      node.click(); return true;
    }`);
    if (!clicked) throw new JournalStageError('returning-to-list', 'The Kindroid journal editor Back button was not found.');
    await this.waitForJournalList();
  }

  async scan(scope) {
    await this.selectJournalScope(scope); const list = await this.waitForJournalList(); const handles = await this.scanJournalIndex();
    if (!handles.length && !list.empty) throw new JournalStageError('extracting-index', 'No journal rows were found and no empty state was displayed.', list);
    const entries = []; const failures = [];
    for (let index = 0; index < handles.length; index += 1) {
      if (this.cancelled()) throw new JournalStageError('cancelled', 'Journal synchronization was cancelled.');
      this.report('extracting_entry', `${index + 1}/${handles.length}`);
      let editorOpened = false;
      try {
        await this.openJournalEntry(handles[index].handle);
        editorOpened = true;
        const value = await this.readJournalEditor(index, handles[index], scope);
        entries.push({ ...value, remote_handle: handles[index].handle });
        await this.returnToJournalList();
      } catch (error) {
        failures.push({ index, title: handles[index].title, stage: error.stage || 'extracting-entry', error: error.message, diagnostics: error.diagnostics || {} });
        if (editorOpened) try { await this.returnToJournalList(); } catch (_) {}
      }
    }
    return { scope, entries, diagnostics: { rowCount: handles.length, extractedCount: entries.length, failedCount: failures.length, failures, emptyState: Boolean(list.empty) } };
  }

  async openNewJournalEditor(){const ok=await this.run(`() => {const n=s=>String(s||'').replace(/\\s+/g,' ').trim();const buttons=[...document.querySelectorAll('button')];const b=buttons.find(x=>/add|new|create/i.test(x.getAttribute('aria-label')||n(x.textContent)))||buttons.find(x=>x.querySelector('svg')&&/plus/i.test(x.innerHTML));if(!b)return false;b.click();return true;}`);if(!ok)throw new JournalStageError('creating-entry',UI_MAP_ERROR);await this.waitFor('waiting-for-editor',`() => document.querySelector('textarea[maxlength],textarea') || {ready:false}`,{message:'Timed out waiting for the new journal editor.'});}
  async replaceJournalKeywords(keywords){if(keywords.length>8||keywords.some(x=>x.length>50))throw new Error('Invalid journal keywords.');const ok=await this.run(`async () => {for(const b of document.querySelectorAll('button[aria-label^="Remove" i]')){b.click();await new Promise(r=>setTimeout(r,30));}const input=document.querySelector('input[placeholder*="add" i],input[placeholder*="keyword" i]');if(!input)return false;for(const word of ${JSON.stringify(keywords)}){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,word);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,80));}return true;}`);if(!ok)throw new JournalStageError('setting-keywords',UI_MAP_ERROR);}
  async replaceJournalDescription(description){const ok=await this.run(`() => {const t=document.querySelector('textarea[maxlength],textarea');if(!t)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(description)});t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));return true;}`);if(!ok)throw new JournalStageError('setting-description',UI_MAP_ERROR);}
  async clickText(text, stage){const ok=await this.run(`() => {const n=s=>String(s||'').replace(/\\s+/g,' ').trim();const b=[...document.querySelectorAll('button')].find(x=>n(x.textContent)===${JSON.stringify(text)});if(!b)return false;b.click();return true;}`);if(!ok)throw new JournalStageError(stage||'clicking-control',UI_MAP_ERROR);}
  async saveJournalEntry(){await this.clickText('Save changes','saving-entry');await this.waitForJournalList();}
  async deleteJournalEntry(){await this.clickText('Delete entry','deleting-entry');await this.waitFor('confirming-delete',`() => [...document.querySelectorAll('button')].some(x=>String(x.textContent||'').trim()==='Delete') || {ready:false}`,{message:'Delete confirmation did not appear.'});await this.clickText('Delete','confirming-delete');await this.waitForJournalList();}
}

module.exports = { KindroidJournalAdapter, JournalStageError, UI_MAP_ERROR };
