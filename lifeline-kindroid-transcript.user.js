// ==UserScript==
// @name         LIFELINE Kindroid Transcript Bridge
// @namespace    https://github.com/unclesam45/LIFELINE
// @version      1.2.5
// @description  Captures Kindroid group-call transcripts and merges them into LIFELINE_BRIDGE.
// @match        https://kindroid.ai/v2/call/*
// @match        https://www.kindroid.ai/v2/call/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      api.github.com
// @run-at       document-idle
// ==/UserScript==

(function lifelineTranscriptBridge() {
  'use strict';

  const BRIDGE_OWNER = 'unclesam45';
  const BRIDGE_REPO = 'LIFELINE_BRIDGE';
  const BRIDGE_BRANCH = 'main';
  const BRIDGE_CONFIG_PATH = 'config.json';
  const TOKEN_KEY = 'lifeline.githubFineGrainedToken';
  const CAPTURE_RETRY_MS = 3000;
  const CAPTURE_INTERVAL_MS = 60000;
  const WRITE_CONFLICT_RETRIES = 4;
  const THREE_DOT_PATH = 'M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3';
  const TRANSCRIPT_ICON_PATH = 'M3 20l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c3.255 2.777 3.695 7.266 1.029 10.501c-2.666 3.235 -7.615 4.215 -11.574 2.293l-4.7 1';
  const PAGE_NOISE = new Set(['voice call', 'message from you', 'kindroid - your personal artificial intelligence companion']);

  let timer = null;
  let busy = false;
  let autoCapture = true;
  let lastUrl = location.href;
  let ui = null;
  let transcriptPanelActivatedForCall = '';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const textOf = (element) => normalizeText(element?.innerText || element?.textContent);
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const groupId = () => decodeURIComponent(location.pathname.match(/^\/v2\/call\/group\/([^/]+)\/?$/)?.[1] || '').trim();
  const isPageNoise = (text) => PAGE_NOISE.has(normalizeText(text).toLowerCase())
    || /^message from\s+[^\n]+$/i.test(normalizeText(text))
    || /^(?:\d+\s*[hms]\s*){1,3}$/i.test(normalizeText(text));

  function request(options) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      ...options,
      onload: resolve,
      onerror: () => reject(new Error('Could not connect to GitHub. Check the browser connection and Tampermonkey permissions.')),
      ontimeout: () => reject(new Error('The GitHub request timed out.')),
      timeout: 30000,
    }));
  }

  function githubHeaders(token) {
    return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  }

  function contentUrl(repoPath, includeRef = true, cacheBuster = '') {
    const encoded = repoPath.split('/').map(encodeURIComponent).join('/');
    const query = [];
    if (includeRef) query.push(`ref=${encodeURIComponent(BRIDGE_BRANCH)}`);
    if (cacheBuster) query.push(`lifeline_cache=${encodeURIComponent(cacheBuster)}`);
    return `https://api.github.com/repos/${BRIDGE_OWNER}/${BRIDGE_REPO}/contents/${encoded}${query.length ? `?${query.join('&')}` : ''}`;
  }

  function parseGithubResponse(response, action) {
    let data = {};
    try { data = response.responseText ? JSON.parse(response.responseText) : {}; } catch (_error) { /* Report HTTP status below. */ }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(data.message || `${action} failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function decodeBase64Utf8(value) {
    const bytes = Uint8Array.from(atob(String(value || '').replace(/\s/g, '')), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  }

  async function readTranscript(token, repoPath, attempt = 0) {
    // A stale Contents API response supplies an obsolete blob SHA and makes the
    // following PUT fail with "<path> does not match <sha>". Every optimistic
    // retry must therefore bypass both the browser and intermediary caches.
    const cacheBuster = `${Date.now()}-${attempt}-${Math.random().toString(36).slice(2)}`;
    const response = await request({
      method: 'GET',
      url: contentUrl(repoPath, true, cacheBuster),
      headers: { ...githubHeaders(token), 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (response.status === 404) return { sha: '', doc: null };
    const file = parseGithubResponse(response, 'Reading the bridge transcript');
    try { return { sha: file.sha || '', doc: JSON.parse(decodeBase64Utf8(file.content)) }; }
    catch (error) { throw new Error(`Could not parse the existing transcript JSON: ${error.message}`); }
  }

  async function readGroupmakerParticipants(token, id) {
    const response = await request({ method: 'GET', url: contentUrl(BRIDGE_CONFIG_PATH), headers: githubHeaders(token) });
    if (response.status === 404) return [];
    const file = parseGithubResponse(response, 'Reading GROUPMAKER participant metadata');
    let config;
    try { config = JSON.parse(decodeBase64Utf8(file.content)); }
    catch (error) { throw new Error(`Could not parse bridge config participant metadata: ${error.message}`); }
    const sessions = Array.isArray(config?.groupmaker_sessions) ? config.groupmaker_sessions : [];
    const session = sessions.filter((row) => normalizeText(row?.group_id) === id)
      .sort((left, right) => normalizeText(right?.touched_at).localeCompare(normalizeText(left?.touched_at)))[0];
    return [...new Set((Array.isArray(session?.names) ? session.names : []).map(normalizeText).filter(Boolean))];
  }

  async function writeTranscript(token, repoPath, doc, sha) {
    const response = await request({
      method: 'PUT', url: contentUrl(repoPath, false), headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      data: JSON.stringify({ message: `Update group transcript ${doc.group_id}`, branch: BRIDGE_BRANCH, content: encodeBase64Utf8(JSON.stringify(doc, null, 2)), ...(sha ? { sha } : {}) }),
    });
    return parseGithubResponse(response, 'Saving the bridge transcript');
  }

  function isWriteConflict(error) {
    return error?.status === 409
      || (error?.status === 422 && /does not match|sha/i.test(String(error.message || '')));
  }

  function transcriptEntries(doc) {
    if (Array.isArray(doc?.transcript)) return doc.transcript.map(normalizeText).filter(Boolean);
    return (Array.isArray(doc?.entries) ? doc.entries : []).map((entry) => normalizeText(entry?.text)).filter((text) => text && !isPageNoise(text));
  }

  function mergeTranscript(existing, id, bubbles, authoritativeParticipants = []) {
    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    const prior = transcriptEntries(base);
    const captured = bubbles.map((bubble) => normalizeText(bubble.text)).filter((text) => text && !isPageNoise(text));
    let overlap = 0;
    for (let size = Math.min(prior.length, captured.length); size > 0; size -= 1) {
      if (prior.slice(-size).every((text, index) => text === captured[index])) { overlap = size; break; }
    }
    const appended = captured.slice(overlap);
    const detectedParticipants = [...new Set(bubbles.map((bubble) => normalizeText(bubble.speaker)).filter(Boolean))];
    const preservedParticipants = Array.isArray(base.participants) ? base.participants.map(normalizeText).filter(Boolean) : [];
    const configuredParticipants = authoritativeParticipants.map(normalizeText).filter(Boolean);
    const doc = {
      version: 2,
      group_id: id,
      // GROUPMAKER is authoritative for membership. DOM speaker detection is only
      // a fallback for transcript files not initialized by the frontend.
      participants: configuredParticipants.length ? [...new Set(configuredParticipants)] : (preservedParticipants.length ? preservedParticipants : detectedParticipants),
      transcript: prior.concat(appended),
    };
    return { doc, added: appended.length, changed: JSON.stringify(base) !== JSON.stringify(doc) };
  }

  async function saveMerged(token, id, bubbles) {
    const repoPath = `transcripts/${id}/transcript.json`;
    let current = await readTranscript(token, repoPath, 0);
    const currentParticipants = Array.isArray(current.doc?.participants) ? current.doc.participants.map(normalizeText).filter(Boolean) : [];
    const configuredParticipants = currentParticipants.length ? [] : await readGroupmakerParticipants(token, id);
    let merged = mergeTranscript(current.doc, id, bubbles, configuredParticipants);
    if (!merged.changed) return { ...merged, repoPath };

    for (let attempt = 0; attempt <= WRITE_CONFLICT_RETRIES; attempt += 1) {
      try {
        await writeTranscript(token, repoPath, merged.doc, current.sha);
        return { ...merged, repoPath };
      } catch (error) {
        if (!isWriteConflict(error) || attempt === WRITE_CONFLICT_RETRIES) throw error;
        await sleep(250 * (attempt + 1));
        current = await readTranscript(token, repoPath, attempt + 1);
        merged = mergeTranscript(current.doc, id, bubbles, configuredParticipants);
        // Another writer may already have saved exactly these entries.
        if (!merged.changed) return { ...merged, repoPath };
      }
    }
    throw new Error('Could not save the transcript after refreshing its GitHub revision.');
  }

  // Kindroid's call controls rely on the complete pointer-like activation
  // sequence. Use it only while opening Transcript; successful activation is
  // remembered below so synchronization never clicks page controls afterward.
  function clickElement(element) {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.click();
  }

  function isThreeDots(button) {
    if (button?.tagName?.toLowerCase() !== 'button' || button.getAttribute('type') !== 'button') return false;
    const popupType = button.getAttribute('aria-haspopup');
    if (popupType !== 'listbox' && popupType !== 'menu' && popupType !== 'true') return false;
    const legacyPath = button.querySelector("svg[viewBox='0 0 16 16'] path")?.getAttribute('d') || '';
    if (legacyPath === THREE_DOT_PATH || legacyPath.includes('M3 9.5a1.5')) return true;
    const dots = [...(button.querySelector("svg[viewBox='0 0 24 24']")?.querySelectorAll('circle') || [])]
      .map((circle) => `${circle.getAttribute('cx')},${circle.getAttribute('cy')},${circle.getAttribute('r')}`).sort();
    return dots.join('|') === '12,12,1|19,12,1|5,12,1';
  }

  function findTranscriptOption() {
    // Kindroid has shipped the Transcript choice both with and without an
    // explicit menu role, so exact-text buttons must remain valid candidates.
    const candidates = [...document.querySelectorAll("[role='option'], [role='menuitem'], button")];
    return candidates.find((option) => {
      if (!visible(option) || !/^Transcript$/i.test(textOf(option.querySelector('p.chakra-text') || option))) return false;
      const path = option.querySelector('svg path')?.getAttribute('d');
      return !path || path.trim() === TRANSCRIPT_ICON_PATH;
    }) || [...document.querySelectorAll("[role='option'] p, [role='menuitem'] p, [role='option'], [role='menuitem']")]
      .find((element) => visible(element) && /^Transcript$/i.test(textOf(element)))?.closest("[role='option'], [role='menuitem']");
  }

  async function extractTranscript() {
    const rowSelectors = ['[class*="call-transcript-panel-v2_row__"]', '[class*="call-transcript-panel_row__"]', '[class*="transcript"][class*="row"]'];
    let rows = [...new Set(rowSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]))].filter(visible);
    const callId = groupId();
    if (rows.length) transcriptPanelActivatedForCall = callId;
    if (!rows.length && transcriptPanelActivatedForCall !== callId) {
      const menuButtons = [...document.querySelectorAll('button[type="button"]')].filter((button) => visible(button) && isThreeDots(button));
      const button = menuButtons[0];
      if (button) {
        clickElement(button);
        let option = null;
        for (let attempt = 0; attempt < 16 && !option; attempt += 1) { await sleep(attempt ? 150 : 350); option = findTranscriptOption(); }
        if (option) {
          clickElement(option);
          transcriptPanelActivatedForCall = callId;
          await sleep(900);
        }
      }
    }
    if (!rows.length) {
      for (let attempt = 0; attempt < 20 && !rows.length; attempt += 1) {
        rows = [...new Set(rowSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]))].filter(visible);
        if (!rows.length) await sleep(150);
      }
    }
    return rows.map((row) => ({
      text: textOf(row.querySelector('[class*="call-transcript-panel-v2_text__"], [class*="call-transcript-panel_text__"], [class*="transcript"][class*="text"]') || row),
      speaker: row.getAttribute('data-speaker') || textOf(row.querySelector('[class*="speaker"], [class*="name"], [data-speaker]')),
    })).filter((bubble) => bubble.text);
  }

  function setStatus(message, state = '') {
    if (!ui) return;
    ui.status.textContent = message;
    ui.status.dataset.state = state;
  }

  async function capture() {
    if (busy) return false;
    const id = groupId();
    const token = ui.token.value.trim();
    if (!id) { setStatus('Open a Kindroid group call to capture its transcript.', 'error'); return false; }
    if (!token) { setStatus('Enter a fine-grained GitHub token first.', 'error'); ui.token.focus(); return false; }
    busy = true; ui.capture.disabled = true; setStatus('Opening transcript panel…');
    try {
      const bubbles = await extractTranscript();
      if (!bubbles.length) throw new Error('No transcript rows found yet. Start the call or open its Transcript panel, then retry.');
      setStatus(`Found ${bubbles.length} rows. Syncing with GitHub…`);
      const result = await saveMerged(token, id, bubbles);
      setStatus(`Saved ${result.added} new entr${result.added === 1 ? 'y' : 'ies'} (${result.doc.transcript.length} total).`, 'success');
      return true;
    } catch (error) {
      const hint = error.status === 401 || error.status === 403 ? ' Check that the token can read and write Contents in LIFELINE_BRIDGE.' : '';
      setStatus(`${error.message}${hint}`, 'error');
      return false;
    } finally { busy = false; ui.capture.disabled = false; }
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (!autoCapture || !ui?.token.value.trim() || !groupId()) return;
    timer = setTimeout(async () => { const saved = await capture(); schedule(saved ? CAPTURE_INTERVAL_MS : CAPTURE_RETRY_MS); }, delay);
  }

  function mountUi() {
    const host = document.createElement('div');
    host.id = 'lifeline-transcript-bridge';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:18px;bottom:18px;font-family:Inter,system-ui,sans-serif';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      .panel{box-sizing:border-box;width:330px;padding:14px;border:1px solid #46d7c5;border-radius:14px;background:#101a20ee;color:#ecfffc;box-shadow:0 16px 48px #0009;font-size:13px}.head{display:flex;align-items:center;justify-content:space-between;gap:8px}.head b{letter-spacing:.08em;color:#72eadb}.min{border:0;background:transparent;color:#bce9e4;font-size:18px;cursor:pointer}.body.hidden{display:none}label{display:block;margin:12px 0 6px;color:#bce9e4}input[type=password]{box-sizing:border-box;width:100%;padding:9px;border:1px solid #41646a;border-radius:8px;background:#071014;color:white}button.action{margin-top:10px;padding:9px 12px;border:0;border-radius:8px;background:#46d7c5;color:#071014;font-weight:700;cursor:pointer}button.action:disabled{opacity:.55}.row{display:flex;align-items:center;gap:10px}.forget{margin-top:10px;border:0;background:transparent;color:#ffa3a3;cursor:pointer}.remember{display:flex;align-items:center;gap:6px;margin:9px 0}.status{min-height:32px;margin:10px 0 0;color:#c6d7da;line-height:1.35}.status[data-state=error]{color:#ffabab}.status[data-state=success]{color:#8ff0b1}.note{font-size:11px;color:#8eaaae;line-height:1.35}
    </style><section class="panel"><div class="head"><b>LIFELINE TRANSCRIPT</b><button class="min" title="Minimize">−</button></div><div class="body"><label>GitHub fine-grained token</label><input class="token" type="password" autocomplete="off" placeholder="github_pat_…"><label class="remember"><input class="rememberBox" type="checkbox"> Remember in Tampermonkey</label><div class="row"><button class="action capture">Capture now</button><button class="forget">Forget token</button></div><p class="status">Enter a token with Contents read/write access to LIFELINE_BRIDGE.</p><p class="note">While this panel is open, capture retries every 3 seconds and syncs every minute after success. Your token is sent only to api.github.com.</p></div></section>`;
    document.documentElement.appendChild(host);
    ui = {
      host, body: shadow.querySelector('.body'), token: shadow.querySelector('.token'), remember: shadow.querySelector('.rememberBox'),
      capture: shadow.querySelector('.capture'), status: shadow.querySelector('.status'),
    };
    const saved = GM_getValue(TOKEN_KEY, '');
    ui.token.value = saved; ui.remember.checked = Boolean(saved);
    shadow.querySelector('.min').addEventListener('click', (event) => { ui.body.classList.toggle('hidden'); event.currentTarget.textContent = ui.body.classList.contains('hidden') ? '+' : '−'; });
    ui.capture.addEventListener('click', async () => { await capture(); schedule(CAPTURE_INTERVAL_MS); });
    ui.token.addEventListener('change', () => { if (ui.remember.checked && ui.token.value.trim()) GM_setValue(TOKEN_KEY, ui.token.value.trim()); schedule(500); });
    ui.remember.addEventListener('change', () => { if (ui.remember.checked && ui.token.value.trim()) GM_setValue(TOKEN_KEY, ui.token.value.trim()); else GM_deleteValue(TOKEN_KEY); });
    shadow.querySelector('.forget').addEventListener('click', () => { GM_deleteValue(TOKEN_KEY); ui.token.value = ''; ui.remember.checked = false; clearTimeout(timer); setStatus('Token removed from Tampermonkey storage.'); });
    if (!groupId()) setStatus('This bridge currently records group calls. Open a /v2/call/group/… page.', 'error');
    else if (saved) { setStatus('Token restored. Automatic capture is active.'); schedule(1000); }
  }

  mountUi();
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    setStatus(groupId() ? 'Group call changed. Preparing automatic capture…' : 'Open a Kindroid group call to capture its transcript.', groupId() ? '' : 'error');
    schedule(1000);
  }, 1000);
})();
