// ==UserScript==
// @name         Kindroid Inline Replies (LIFELINE)
// @namespace    https://github.com/unclesam45/LIFELINE
// @version      2.2.0
// @description  Collapsible sidebar for sending a continuation or an on-the-fly Kindroid call message.
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
  const CONTINUE_MESSAGE = '*CONTINUES CONVERSATION*';
  const COMPOSER_SELECTORS = ['textarea:not([disabled]):not([readonly])', 'input[type="text"]:not([disabled]):not([readonly])', 'input[type="search"]:not([disabled]):not([readonly])', '[contenteditable="true"]', '[role="textbox"]'];
  let sendLockUntil = 0;

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
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;left:12px;top:50%;transform:translateY(-50%);font-family:Inter,ui-sans-serif,system-ui,sans-serif;color-scheme:dark';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      *{box-sizing:border-box}button,textarea,input{font:inherit}.shell{display:flex;align-items:stretch;filter:drop-shadow(0 22px 42px #0009)}.rail{width:42px;border:1px solid #ffffff20;border-right:0;border-radius:14px 0 0 14px;background:linear-gradient(180deg,#202029f5,#101014f5);color:#fff;cursor:pointer;font:800 11px/1 sans-serif;letter-spacing:.13em;writing-mode:vertical-rl;padding:13px 8px}.rail.solo{border-right:1px solid #ffffff20;border-radius:14px}.panel{width:min(292px,calc(100vw - 66px));max-height:82vh;overflow:hidden;border:1px solid #ffffff20;border-radius:0 18px 18px 0;background:linear-gradient(160deg,#1b1b23f7,#101014f7);color:#f7f7fa;backdrop-filter:blur(18px)}.panel.hidden{display:none}
      .head{padding:17px 16px 13px;border-bottom:1px solid #ffffff12}.eyebrow{color:#9d8cff;font:800 10px/1 sans-serif;letter-spacing:.18em}.title{margin-top:7px;font:750 18px/1.2 sans-serif}.sub{margin:4px 0 0;color:#9897a3;font:500 11px/1.4 sans-serif}.content{max-height:calc(82vh - 92px);overflow:auto;padding:12px;scrollbar-width:thin;scrollbar-color:#ffffff25 transparent}.preset{width:100%;padding:12px;border:1px solid #ffffff16;border-radius:11px;background:#ffffff08;color:#f5f4f8;text-align:left;cursor:pointer;font:750 12px/1.25 sans-serif}.preset:hover{border-color:#9d8cff99;background:#9d8cff18;transform:translateX(2px)}
      .field{display:block;margin-top:14px;color:#aaa8b4;font:700 10px/1.2 sans-serif;letter-spacing:.06em}.field textarea{display:block;width:100%;min-height:150px;margin-top:7px;border:1px solid #ffffff1f;border-radius:11px;background:#09090d;color:#fff;outline:none;padding:12px;font:13px/1.45 sans-serif;resize:vertical}.field textarea:focus{border-color:#9d8cff;box-shadow:0 0 0 3px #9d8cff20}.hint{margin:7px 2px 0;color:#777681;font:10px/1.4 sans-serif}.status{min-height:16px;margin:10px 2px 0;color:#8e8c97;font:10px/1.4 sans-serif}.status[data-state=error]{color:#ff9b9b}.status[data-state=success]{color:#7ee2b8}
    </style><div class="shell"><button class="rail" type="button" aria-expanded="true">OOC</button><section class="panel"><header class="head"><div class="eyebrow">KINDROID</div><div class="title">Call message</div><p class="sub">Send the continuation or write your own</p></header><main class="content"><button class="preset" type="button">*CONTINUES CONVERSATION*</button><label class="field">MESSAGE<textarea class="custom-message" maxlength="2000" placeholder="Type a message and press Enter…" aria-label="Custom message"></textarea></label><p class="hint">Enter sends · Shift + Enter adds a new line</p><div class="status" aria-live="polite">Ready</div></main></section></div>`;
    document.documentElement.appendChild(host);

    const $ = (selector) => shadow.querySelector(selector);
    const panel = $('.panel'); const rail = $('.rail'); const customMessage = $('.custom-message'); const status = $('.status');
    const showStatus = (text, state = '') => { status.textContent = text; status.dataset.state = state; };
    $('.preset').addEventListener('click', async () => { try { await send(CONTINUE_MESSAGE); showStatus('Continuation sent', 'success'); } catch (error) { showStatus(error.message, 'error'); } });
    customMessage.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      const message = customMessage.value.trim();
      if (!message) return showStatus('Enter a message first.', 'error');
      try { await send(message); customMessage.value = ''; showStatus('Message sent', 'success'); }
      catch (error) { showStatus(error.message, 'error'); }
    });
    rail.addEventListener('click', () => { const hidden = panel.classList.toggle('hidden'); rail.classList.toggle('solo', hidden); rail.textContent = hidden ? 'OOC ＋' : 'OOC'; rail.setAttribute('aria-expanded', String(!hidden)); });
    return global.LifelineKindroidToolkit;
  }

  const toolkit = { mount, send, findComposer };
  global.LifelineKindroidToolkit = Object.freeze(toolkit);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
  global.setInterval(mount, 1000);
})(window);
