// ==UserScript==
// @name         Kindroid Inline Replies (LIFELINE)
// @namespace    https://github.com/unclesam45/LIFELINE
// @version      2.1.1
// @description  Collapsible quick-reply sidebar with user-defined presets for Kindroid calls.
// @match        https://kindroid.ai/call*
// @match        https://kindroid.ai/groupchat/*/call*
// @match        https://kindroid.ai/v2/call/*
// @match        https://www.kindroid.ai/call*
// @match        https://www.kindroid.ai/groupchat/*/call*
// @match        https://www.kindroid.ai/v2/call/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function createLifelineKindroidToolkit(global) {
  'use strict';

  const HOST_ID = 'lifeline-kindroid-call-toolkit';
  const STORAGE_KEY = 'lifeline.kindroid.inline-replies.v2.presets';
  const DEFAULT_PRESETS = [
    { label: 'NARRATION', message: 'OOC : Speak dialogue only and avoid narrating thoughts or actions.' },
    { label: 'FOCUS', message: 'OOC : FOCUS ON WHO IS SPEAKING BY NAME . Stay faithful to the backstory. MAKE SURE TO SPEAK AS THE PROPER CHARACTER . DO NOT REPEAT OR REUSE RESPONSES . BRING TOTAL ORIGINALITY TO THE CONVERSATION WITH FRESH RESPONSES' },
    { label: 'CONCISE', message: 'OOC : Keep responses short and concise.' },
    { label: 'SUBJECT', message: 'OOC : BRING THE CONVERSATION TOWARDS A DIFFERENT TOPIC . TAKE ANOTHER DIRECTION.' },
    { label: 'ANTI REPEAT', message: "OOC : DON'T MENTION REPEATED MESSAGES . IGNORE REPEATED MESSAGES AND CONTINUE THE CONVERSATION FORWARD ." },
    { label: 'CONTINUE', message: 'OOC : CONTINUE THE CONVERSATION . BRING ORIGINALITY AND VARIETY IN THE CONVERSATION AND MAKE THE SITUATION PROCEED FORWARD.' },
    { label: 'EVENT', message: 'OOC : BRING SPONTANEITY TO THE CONVERSATION . CONTINUE THE STORYLINE WITH A RANDOM EVENT OCCURRING . A RANDOM EVENT HAPPENS TAKING THE STORYLINE FORWARD' },
    { label: 'NO SAM', message: 'OOC : STOP FOCUSING ON SAM. BRING THE CONVERSATION FORWARD WITH ORIGINALITY . DO NOT FOCUS ON SAM AND PROCEED WITH A NEW SUBJECT TO KEEP THE CONVERSATION FORWARD .' },
    { label: 'LOCAL', message: 'OOC : EVERYONE ARE NOW ALL TOGETHER IN THE SAME LOCATION . ALL PARTICIPANTS OF THIS CONVERSATION HAVE NOW PHYSICALLY JOINED EACH OTHER AND ARE CURRENTLY IN THE SAME LOCATION' },
    { label: 'SMALL TALK', message: '*THEY ENGAGE IN SMALL TALK*' },
  ];
  const COMPOSER_SELECTORS = ['textarea:not([disabled]):not([readonly])', 'input[type="text"]:not([disabled]):not([readonly])', 'input[type="search"]:not([disabled]):not([readonly])', '[contenteditable="true"]', '[role="textbox"]'];
  let sendLockUntil = 0;

  const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const withIds = (items) => items.map((item) => ({ id: item.id || makeId(), label: String(item.label || '').trim(), message: String(item.message || '').trim() }));
  function loadPresets() {
    try {
      const parsed = JSON.parse(global.localStorage.getItem(STORAGE_KEY));
      if (Array.isArray(parsed)) return withIds(parsed.filter((item) => item && item.label && item.message));
    } catch (_) { /* Use defaults when browser storage is unavailable or malformed. */ }
    return withIds(DEFAULT_PRESETS);
  }
  function savePresets(presets) {
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  }

  function isVisible(element) {
    if (!element || !element.isConnected || element.closest(`#${HOST_ID}`)) return false;
    const style = global.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.bottom > 0 && rect.right > 0 && rect.top < global.innerHeight && rect.left < global.innerWidth;
  }
  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const candidates = [...document.querySelectorAll(selector)].filter(isVisible).sort((a, b) => b.clientWidth - a.clientWidth);
      if (candidates[0]) return candidates[0];
    }
    return null;
  }
  function setComposerValue(composer, value) {
    composer.focus();
    if (composer.isContentEditable) {
      composer.textContent = '';
      composer.appendChild(document.createTextNode(value));
    } else {
      const prototype = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(composer, value); else composer.value = value;
    }
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function pressEnter(composer) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    composer.dispatchEvent(new KeyboardEvent('keydown', init));
    composer.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  async function send(value) {
    const message = String(value || '').trim();
    if (!message) throw new Error('Enter a reply first.');
    if (Date.now() < sendLockUntil) throw new Error('Please wait a moment before sending again.');
    const composer = findComposer();
    if (!composer) throw new Error('No visible Kindroid message box was found.');
    sendLockUntil = Date.now() + 800;
    setComposerValue(composer, message);
    await new Promise((resolve) => global.setTimeout(resolve, 60));
    pressEnter(composer);
    return message;
  }

  function mount() {
    if (!/(^\/call|\/call(?:\/|$))/.test(global.location.pathname)) return global.LifelineKindroidToolkit;
    if (document.getElementById(HOST_ID)) return global.LifelineKindroidToolkit;
    let presets = loadPresets();
    let editingId = null;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;left:12px;top:50%;transform:translateY(-50%);font-family:Inter,ui-sans-serif,system-ui,sans-serif;color-scheme:dark';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      *{box-sizing:border-box}button,textarea,input{font:inherit}.shell{display:flex;align-items:stretch;filter:drop-shadow(0 22px 42px #0009)}.rail{width:42px;border:1px solid #ffffff20;border-right:0;border-radius:14px 0 0 14px;background:linear-gradient(180deg,#202029f5,#101014f5);color:#fff;cursor:pointer;font:800 11px/1 sans-serif;letter-spacing:.13em;writing-mode:vertical-rl;padding:13px 8px}.rail.solo{border-right:1px solid #ffffff20;border-radius:14px}.panel{width:min(292px,calc(100vw - 66px));max-height:82vh;overflow:hidden;border:1px solid #ffffff20;border-radius:0 18px 18px 0;background:linear-gradient(160deg,#1b1b23f7,#101014f7);color:#f7f7fa;backdrop-filter:blur(18px)}.panel.hidden{display:none}
      .head{padding:17px 16px 13px;border-bottom:1px solid #ffffff12}.eyebrow{color:#9d8cff;font:800 10px/1 sans-serif;letter-spacing:.18em}.title-row{display:flex;align-items:center;justify-content:space-between;margin-top:7px}.title{font:750 18px/1.2 sans-serif}.gear{width:34px;height:34px;border:1px solid #ffffff18;border-radius:10px;background:#ffffff09;color:#d9d8df;cursor:pointer;font-size:17px}.gear:hover,.gear.active{background:#8b75ff26;border-color:#9d8cff}.sub{margin:4px 0 0;color:#9897a3;font:500 11px/1.4 sans-serif}.content{max-height:calc(82vh - 92px);overflow:auto;padding:12px;scrollbar-width:thin;scrollbar-color:#ffffff25 transparent}.list{display:grid;gap:7px}.row{display:flex;gap:6px}.preset{min-width:0;flex:1;padding:11px 12px;border:1px solid #ffffff16;border-radius:11px;background:#ffffff08;color:#f5f4f8;text-align:left;cursor:pointer;font:750 11px/1.25 sans-serif;letter-spacing:.025em}.preset:hover{border-color:#9d8cff99;background:#9d8cff18;transform:translateX(2px)}.actions{display:none;gap:4px}.manage .actions{display:flex}.icon{width:31px;border:1px solid #ffffff14;border-radius:9px;background:#ffffff07;color:#aaa8b2;cursor:pointer}.icon:hover{color:#fff;background:#ffffff12}.empty{padding:26px 12px;text-align:center;color:#8e8c97;font:12px/1.5 sans-serif}
      .editor{display:none;margin-bottom:12px;padding:12px;border:1px solid #9d8cff55;border-radius:13px;background:#9d8cff0d}.editor.open{display:block}.field{display:block;margin-bottom:9px;color:#aaa8b4;font:700 10px/1.2 sans-serif;letter-spacing:.06em}.field input,.field textarea{display:block;width:100%;margin-top:6px;border:1px solid #ffffff1f;border-radius:9px;background:#09090d;color:#fff;outline:none;padding:9px 10px;font:12px/1.4 sans-serif}.field textarea{min-height:88px;resize:vertical}.field input:focus,.field textarea:focus{border-color:#9d8cff;box-shadow:0 0 0 3px #9d8cff20}.editor-buttons{display:flex;gap:7px}.save,.cancel,.add,.reset{border:0;border-radius:9px;cursor:pointer;padding:9px 11px;font:750 11px/1 sans-serif}.save,.add{background:linear-gradient(135deg,#a18cff,#7965e8);color:white}.cancel,.reset{background:#ffffff0d;color:#c7c5ce}.toolbar{display:none;gap:7px;margin-top:12px}.manage .toolbar{display:flex}.add{flex:1}.reset{border:1px solid #ffffff12}.status{min-height:16px;margin:10px 2px 0;color:#8e8c97;font:10px/1.4 sans-serif}.status[data-state=error]{color:#ff9b9b}.status[data-state=success]{color:#7ee2b8}
    </style><div class="shell"><button class="rail" type="button" aria-expanded="true">OOC</button><section class="panel"><header class="head"><div class="eyebrow">KINDROID</div><div class="title-row"><div class="title">Quick replies</div><button class="gear" type="button" aria-label="Manage presets" title="Manage presets">⚙</button></div><p class="sub">Tap a preset to send it instantly</p></header><main class="content"><form class="editor"><label class="field">BUTTON NAME<input class="label" maxlength="32" placeholder="e.g. CHANGE TOPIC" required></label><label class="field">MESSAGE<textarea class="message" maxlength="2000" placeholder="The exact message Kindroid will receive" required></textarea></label><div class="editor-buttons"><button class="save" type="submit">Save preset</button><button class="cancel" type="button">Cancel</button></div></form><div class="list"></div><div class="toolbar"><button class="add" type="button">＋ New preset</button><button class="reset" type="button" title="Restore the starter presets">Reset</button></div><div class="status" aria-live="polite">Ready</div></main></section></div>`;
    document.documentElement.appendChild(host);

    const $ = (selector) => shadow.querySelector(selector);
    const panel = $('.panel'); const rail = $('.rail'); const content = $('.content'); const form = $('.editor'); const labelInput = $('.label'); const messageInput = $('.message'); const status = $('.status');
    const showStatus = (text, state = '') => { status.textContent = text; status.dataset.state = state; };
    const persist = () => { try { savePresets(presets); return true; } catch (_) { showStatus('Presets could not be saved in this browser.', 'error'); return false; } };
    const closeEditor = () => { editingId = null; form.classList.remove('open'); form.reset(); };
    const openEditor = (preset) => { editingId = preset?.id || null; labelInput.value = preset?.label || ''; messageInput.value = preset?.message || ''; form.classList.add('open'); content.scrollTop = 0; global.setTimeout(() => labelInput.focus(), 0); };
    const render = () => {
      const list = $('.list'); list.textContent = '';
      if (!presets.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No presets yet. Create one to get started.'; list.appendChild(empty); }
      presets.forEach((preset) => {
        const row = document.createElement('div'); row.className = 'row';
        const button = document.createElement('button'); button.type = 'button'; button.className = 'preset'; button.textContent = preset.label; button.title = preset.message;
        button.addEventListener('click', async () => { try { await send(preset.message); showStatus(`${preset.label} sent`, 'success'); } catch (error) { showStatus(error.message, 'error'); } });
        const actions = document.createElement('div'); actions.className = 'actions';
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon'; edit.textContent = '✎'; edit.title = `Edit ${preset.label}`; edit.setAttribute('aria-label', edit.title); edit.addEventListener('click', () => openEditor(preset));
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon'; remove.textContent = '×'; remove.title = `Delete ${preset.label}`; remove.setAttribute('aria-label', remove.title); remove.addEventListener('click', () => { if (!global.confirm(`Delete “${preset.label}”?`)) return; presets = presets.filter(({ id }) => id !== preset.id); persist(); closeEditor(); render(); showStatus('Preset deleted.', 'success'); });
        actions.append(edit, remove); row.append(button, actions); list.appendChild(row);
      });
    };
    $('.gear').addEventListener('click', (event) => { content.classList.toggle('manage'); event.currentTarget.classList.toggle('active'); showStatus(content.classList.contains('manage') ? 'Manage mode: add, edit, or remove presets.' : 'Ready'); closeEditor(); });
    $('.add').addEventListener('click', () => openEditor()); $('.cancel').addEventListener('click', closeEditor);
    $('.reset').addEventListener('click', () => { if (!global.confirm('Restore the starter presets? Your custom presets will be removed.')) return; presets = withIds(DEFAULT_PRESETS); persist(); closeEditor(); render(); showStatus('Starter presets restored.', 'success'); });
    form.addEventListener('submit', (event) => { event.preventDefault(); const label = labelInput.value.trim(); const message = messageInput.value.trim(); if (!label || !message) return showStatus('Both a button name and message are required.', 'error'); const wasEditing = Boolean(editingId); if (editingId) presets = presets.map((item) => item.id === editingId ? { ...item, label, message } : item); else presets.push({ id: makeId(), label, message }); if (!persist()) return; closeEditor(); render(); showStatus(wasEditing ? 'Preset updated.' : 'Preset saved.', 'success'); });
    rail.addEventListener('click', () => { const hidden = panel.classList.toggle('hidden'); rail.classList.toggle('solo', hidden); rail.textContent = hidden ? 'OOC ＋' : 'OOC'; rail.setAttribute('aria-expanded', String(!hidden)); });
    render();
    return global.LifelineKindroidToolkit;
  }

  const toolkit = { mount, send, findComposer, loadPresets, storageKey: STORAGE_KEY };
  global.LifelineKindroidToolkit = Object.freeze(toolkit);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
  global.setInterval(mount, 1000);
})(window);
