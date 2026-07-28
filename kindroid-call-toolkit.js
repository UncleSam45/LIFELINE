(function createLifelineKindroidToolkit(global) {
  'use strict';

  const HOST_ID = 'lifeline-kindroid-call-toolkit';
  const PRESETS = [
    'CONTINUES CONVERSATION',
    'SAM PHYSICALLY ENTERS THE ROOM',
  ];
  const COMPOSER_SELECTORS = [
    'textarea:not([disabled]):not([readonly])',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'input[type="text"]:not([disabled]):not([readonly])',
  ];

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = global.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }

  function findComposer() {
    const candidates = COMPOSER_SELECTORS.flatMap((selector) => [...document.querySelectorAll(selector)]);
    return candidates.filter(isVisible).sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (rightRect.bottom - leftRect.bottom) || (rightRect.width - leftRect.width);
    })[0] || null;
  }

  function setComposerValue(composer, value) {
    composer.focus();
    if (composer.isContentEditable) {
      composer.textContent = value;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return;
    }
    const prototype = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(composer, value);
    else composer.value = value;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnter(composer) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    composer.dispatchEvent(new KeyboardEvent('keydown', init));
    composer.dispatchEvent(new KeyboardEvent('keypress', init));
    composer.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function wrapMessage(value) {
    return `*${String(value || '').trim()}*`;
  }

  async function send(value) {
    const message = String(value || '').trim();
    if (!message) throw new Error('Type a message first.');
    const composer = findComposer();
    if (!composer) throw new Error('No visible Kindroid message box was found.');
    setComposerValue(composer, wrapMessage(message));
    await new Promise((resolve) => global.setTimeout(resolve, 50));
    pressEnter(composer);
    return wrapMessage(message);
  }

  function mount() {
    if (!/^\/v2\/call\//.test(global.location.pathname)) return global.LifelineKindroidToolkit;
    const existing = document.getElementById(HOST_ID);
    if (existing) return global.LifelineKindroidToolkit;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;left:18px;top:50%;transform:translateY(-50%);font-family:Inter,system-ui,sans-serif';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      *{box-sizing:border-box}.panel{width:min(360px,calc(100vw - 36px));padding:15px;border:1px solid #73e8dc;border-radius:16px;background:#0d171ded;color:#f2fffd;box-shadow:0 18px 55px #000a;backdrop-filter:blur(16px)}
      .head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:11px}.title{font:800 12px/1.2 Inter,system-ui,sans-serif;letter-spacing:.12em;color:#82f3e6}.min{border:0;background:transparent;color:#d8fffa;font-size:20px;cursor:pointer}.body.hidden{display:none}
      textarea{display:block;width:100%;min-height:130px;resize:vertical;padding:12px;border:1px solid #42666b;border-radius:10px;background:#050c10;color:#fff;font:15px/1.45 Inter,system-ui,sans-serif;outline:none}textarea:focus{border-color:#73e8dc;box-shadow:0 0 0 3px #73e8dc22}
      .hint,.status{margin:7px 1px 0;color:#9db9ba;font:11px/1.4 Inter,system-ui,sans-serif}.status[data-state="error"]{color:#ffaaaa}.status[data-state="success"]{color:#8ff0b1}.presets{display:grid;gap:7px;margin-top:12px}.preset{padding:10px;border:1px solid #42666b;border-radius:9px;background:#17272b;color:#eafffc;font:700 11px/1.3 Inter,system-ui,sans-serif;text-align:left;cursor:pointer}.preset:hover{border-color:#73e8dc;background:#20373b}
    </style><section class="panel"><div class="head"><span class="title">LIFELINE CALL TOOLKIT</span><button class="min" type="button" title="Minimize" aria-label="Minimize toolkit">−</button></div><div class="body"><textarea aria-label="Message to send" placeholder="Type a message, then press Enter…"></textarea><p class="hint">Enter sends to Kindroid wrapped in asterisks. Shift+Enter adds a new line.</p><div class="presets"></div><p class="status" aria-live="polite">Ready.</p></div></section>`;
    document.documentElement.appendChild(host);

    const input = shadow.querySelector('textarea');
    const status = shadow.querySelector('.status');
    const showStatus = (text, state = '') => { status.textContent = text; status.dataset.state = state; };
    const submit = async (value) => {
      try { await send(value); input.value = ''; showStatus('Message sent.', 'success'); }
      catch (error) { showStatus(error.message, 'error'); }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      submit(input.value);
    });
    PRESETS.forEach((preset) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'preset'; button.textContent = `*${preset}*`;
      button.addEventListener('click', () => submit(preset));
      shadow.querySelector('.presets').appendChild(button);
    });
    shadow.querySelector('.min').addEventListener('click', (event) => {
      const body = shadow.querySelector('.body');
      body.classList.toggle('hidden');
      event.currentTarget.textContent = body.classList.contains('hidden') ? '+' : '−';
      event.currentTarget.setAttribute('aria-label', body.classList.contains('hidden') ? 'Expand toolkit' : 'Minimize toolkit');
    });
    return global.LifelineKindroidToolkit;
  }

  global.LifelineKindroidToolkit = Object.freeze({ mount, send, findComposer, wrapMessage, presets: [...PRESETS] });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  // Kindroid uses client-side routing, so Electron may inject us on the home
  // page before a call is opened.
  global.setInterval(mount, 1000);
})(window);
