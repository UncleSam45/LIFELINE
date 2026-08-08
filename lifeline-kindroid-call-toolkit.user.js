// ==UserScript==
// @name         Kindroid Inline Replies (LIFELINE)
// @namespace    https://github.com/unclesam45/LIFELINE
// @version      2.3.0
// @description  Adds one inline control that continues the current Kindroid conversation.
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
  const CONTINUATION_MESSAGE = '*CONTINUES CONVERSATION*';
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
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;left:18px;top:50%;transform:translateY(-50%);font-family:Inter,ui-sans-serif,system-ui,sans-serif;color-scheme:dark';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      *{box-sizing:border-box}.continue{width:270px;min-height:64px;padding:16px 20px;border:1px solid #a998ff;border-radius:16px;background:linear-gradient(145deg,#5541b8,#332578);color:#fff;cursor:pointer;box-shadow:0 18px 38px #0009;font:800 14px/1.35 sans-serif;letter-spacing:.055em}.continue:hover{background:linear-gradient(145deg,#6651ce,#403091);transform:translateX(2px)}.continue:focus-visible{outline:3px solid #d4ccff;outline-offset:3px}.continue:disabled{cursor:wait;opacity:.65}.status{width:270px;min-height:16px;margin:7px 2px 0;color:#b8b5c3;font:600 11px/1.35 sans-serif}.status[data-state=error]{color:#ff9b9b}.status[data-state=success]{color:#7ee2b8}
    </style><button class="continue" type="button">*CONTINUES CONVERSATION*</button><div class="status" aria-live="polite"></div>`;
    document.documentElement.appendChild(host);

    const button = shadow.querySelector('.continue');
    const status = shadow.querySelector('.status');
    button.addEventListener('click', async () => {
      button.disabled = true;
      status.textContent = 'Sending…';
      status.dataset.state = '';
      try {
        await send(CONTINUATION_MESSAGE);
        status.textContent = 'Continuation sent.';
        status.dataset.state = 'success';
      } catch (error) {
        status.textContent = error.message;
        status.dataset.state = 'error';
      } finally {
        global.setTimeout(() => { button.disabled = false; }, 800);
      }
    });
    return global.LifelineKindroidToolkit;
  }

  const toolkit = { mount, send, findComposer, continuationMessage: CONTINUATION_MESSAGE };
  global.LifelineKindroidToolkit = Object.freeze(toolkit);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
  global.setInterval(mount, 1000);
})(window);
