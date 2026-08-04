// ==UserScript==
// @name         KINDROID XL
// @namespace    https://github.com/unclesam45/LIFELINE
// @version      0.1.0
// @description  A site-wide enhancement layer for Kindroid, beginning with secure GitHub connection settings.
// @match        https://kindroid.ai/*
// @match        https://www.kindroid.ai/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      api.github.com
// @run-at       document-idle
// ==/UserScript==

(function kindroidXL() {
  'use strict';

  const ENTRY_ID = 'kindroidxl-github-setting';
  const MODAL_ID = 'kindroidxl-github-modal';
  const SETTINGS_PATH = /^\/v2\/settings\/?$/;
  const STORAGE = {
    owner: 'kindroidxl.github.owner',
    repo: 'kindroidxl.github.repo',
    token: 'kindroidxl.github.token',
  };

  const readValue = (key, fallback = '') => Promise.resolve(GM_getValue(key, fallback));
  const writeValue = (key, value) => Promise.resolve(GM_setValue(key, value));
  const removeValue = (key) => Promise.resolve(GM_deleteValue(key));
  const normalize = (value) => String(value || '').trim();

  function githubRequest(owner, repo, token) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET',
      url,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 20000,
      onload(response) {
        let data = {};
        try { data = response.responseText ? JSON.parse(response.responseText) : {}; } catch (_error) {  }
        if (response.status >= 200 && response.status < 300) return resolve(data);
        const hints = {
          401: 'GitHub rejected this token. Check that it is current and was copied completely.',
          403: 'The token does not have permission to access this repository.',
          404: 'Repository not found. Check the owner, name, and fine-grained token access.',
        };
        return reject(new Error(hints[response.status] || data.message || `GitHub returned status ${response.status}.`));
      },
      onerror: () => reject(new Error('Could not reach GitHub. Check your connection and Tampermonkey permissions.')),
      ontimeout: () => reject(new Error('GitHub took too long to respond. Please try again.')),
    }));
  }

  function infoIcon() {
    const wrap = document.createElement('span');
    wrap.className = 'kindroidxl-info-wrap';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'kindroidxl-info';
    button.setAttribute('aria-label', 'About the KINDROID XL GitHub connection');
    button.title = 'Connect KINDROID XL to a GitHub repository. Your token is stored only when you choose Remember token.';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
    wrap.appendChild(button);
    return wrap;
  }

  function closeModal(host) {
    host.classList.add('kindroidxl-closing');
    window.setTimeout(() => host.remove(), 180);
  }

  async function openModal() {
    const existing = document.getElementById(MODAL_ID);
    if (existing) return;

    const [owner, repo, token] = await Promise.all([
      readValue(STORAGE.owner), readValue(STORAGE.repo), readValue(STORAGE.token),
    ]);
    const host = document.createElement('div');
    host.id = MODAL_ID;
    host.innerHTML = `<div class="kindroidxl-backdrop" role="presentation"></div>
      <section class="kindroidxl-dialog" role="dialog" aria-modal="true" aria-labelledby="kindroidxl-title">
        <button class="kindroidxl-close" type="button" aria-label="Close">×</button>
        <div class="kindroidxl-brand"><span class="kindroidxl-mark">XL</span><span>KINDROID XL</span></div>
        <h2 id="kindroidxl-title">Connect your repository</h2>
        <p class="kindroidxl-intro">Give KINDROID XL a private route to the GitHub REST API. Your credentials never pass through Kindroid.</p>
        <form novalidate>
          <div class="kindroidxl-pair">
            <label>GitHub username<input name="owner" autocomplete="username" spellcheck="false" placeholder="octocat" required></label>
            <label>Repository<input name="repo" autocomplete="off" spellcheck="false" placeholder="my-repository" required></label>
          </div>
          <label>Fine-grained token<div class="kindroidxl-token"><input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…" required><button type="button" class="kindroidxl-reveal" aria-label="Show token">Show</button></div></label>
          <label class="kindroidxl-remember"><input name="remember" type="checkbox"><span></span><span><strong>Remember token on this device</strong><small>Saved in Tampermonkey storage, not the Kindroid website.</small></span></label>
          <button class="kindroidxl-connect" type="submit"><span class="kindroidxl-connect-label">Test connection</span><span class="kindroidxl-spinner" aria-hidden="true"></span></button>
          <div class="kindroidxl-status" aria-live="polite"></div>
        </form>
        <div class="kindroidxl-success" aria-hidden="true"><div class="kindroidxl-orbit"><i></i><b>✓</b></div><h3>Connection established</h3><p></p><button type="button">Done</button></div>
      </section>`;
    document.documentElement.appendChild(host);

    const form = host.querySelector('form');
    const ownerInput = form.elements.owner;
    const repoInput = form.elements.repo;
    const tokenInput = form.elements.token;
    const rememberInput = form.elements.remember;
    const status = host.querySelector('.kindroidxl-status');
    const submit = host.querySelector('.kindroidxl-connect');
    ownerInput.value = normalize(owner);
    repoInput.value = normalize(repo);
    tokenInput.value = normalize(token);
    rememberInput.checked = Boolean(token);

    const close = () => closeModal(host);
    host.querySelector('.kindroidxl-close').addEventListener('click', close);
    host.querySelector('.kindroidxl-backdrop').addEventListener('click', close);
    host.querySelector('.kindroidxl-success button').addEventListener('click', close);
    host.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
    host.querySelector('.kindroidxl-reveal').addEventListener('click', (event) => {
      const reveal = tokenInput.type === 'password';
      tokenInput.type = reveal ? 'text' : 'password';
      event.currentTarget.textContent = reveal ? 'Hide' : 'Show';
      event.currentTarget.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} token`);
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const enteredOwner = normalize(ownerInput.value);
      const enteredRepo = normalize(repoInput.value).replace(/^\/+|\/+$/g, '');
      const enteredToken = normalize(tokenInput.value);
      status.className = 'kindroidxl-status';
      if (!enteredOwner || !enteredRepo || !enteredToken) {
        status.textContent = 'Complete all three fields to test the connection.';
        status.classList.add('is-error');
        return;
      }
      submit.disabled = true;
      submit.classList.add('is-loading');
      status.textContent = 'Contacting the GitHub REST API…';
      try {
        const repository = await githubRequest(enteredOwner, enteredRepo, enteredToken);
        await Promise.all([
          writeValue(STORAGE.owner, enteredOwner),
          writeValue(STORAGE.repo, enteredRepo),
          rememberInput.checked ? writeValue(STORAGE.token, enteredToken) : removeValue(STORAGE.token),
        ]);
        const fullName = normalize(repository.full_name) || `${enteredOwner}/${enteredRepo}`;
        host.querySelector('.kindroidxl-success p').textContent = `${fullName} is ready for KINDROID XL.`;
        form.classList.add('is-complete');
        host.querySelector('.kindroidxl-success').classList.add('is-visible');
        host.querySelector('.kindroidxl-success').setAttribute('aria-hidden', 'false');
        updateEntryState();
      } catch (error) {
        status.textContent = error.message;
        status.classList.add('is-error');
        submit.disabled = false;
        submit.classList.remove('is-loading');
      }
    });
    window.setTimeout(() => (ownerInput.value ? tokenInput : ownerInput).focus(), 80);
  }

  async function updateEntryState() {
    const pill = document.querySelector(`#${ENTRY_ID} .kindroidxl-pill`);
    if (!pill) return;
    const [owner, repo] = await Promise.all([readValue(STORAGE.owner), readValue(STORAGE.repo)]);
    pill.textContent = owner && repo ? 'Configured' : 'Connect';
    pill.classList.toggle('is-configured', Boolean(owner && repo));
  }

  function findSettingsRow() {
    const labels = [...document.querySelectorAll('span')];
    const betaLabel = labels.find((span) => normalize(span.textContent) === 'Beta Testing');
    return betaLabel?.closest('[class*="setting-card_row__"]') || document.querySelector('[class*="setting-card_row__"]');
  }

  function mountSettingsEntry() {
    if (!SETTINGS_PATH.test(location.pathname)) {
      document.getElementById(ENTRY_ID)?.remove();
      return;
    }
    if (document.getElementById(ENTRY_ID)) return;
    const reference = findSettingsRow();
    if (!reference?.parentElement) return;
    const row = document.createElement('div');
    row.id = ENTRY_ID;
    row.className = reference.className;
    const labelGroup = document.createElement('span');
    const referenceLabelGroup = reference.firstElementChild;
    labelGroup.className = referenceLabelGroup?.className || 'kindroidxl-label-group';
    const label = document.createElement('span');
    const referenceLabel = [...reference.querySelectorAll('span')].find((span) => normalize(span.textContent) === 'Beta Testing');
    label.className = referenceLabel?.className || 'kindroidxl-label';
    label.textContent = 'KINDROID XL · GitHub';
    labelGroup.append(infoIcon(), label);
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `${reference.querySelector('button:last-child')?.className || ''} kindroidxl-pill`.trim();
    pill.textContent = 'Connect';
    pill.addEventListener('click', openModal);
    row.append(labelGroup, pill);
    reference.insertAdjacentElement('afterend', row);
    updateEntryState();
  }

  GM_addStyle(`
    #${ENTRY_ID}{animation:kindroidxl-row-in .4s cubic-bezier(.2,.8,.2,1) both}
    #${ENTRY_ID} .kindroidxl-info-wrap{display:inline-flex;align-items:center}
    #${ENTRY_ID} .kindroidxl-info{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;background:transparent;color:inherit;opacity:.7;cursor:help}
    #${ENTRY_ID} .kindroidxl-info svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
    #${ENTRY_ID} .kindroidxl-pill.is-configured{color:#bfffdc!important;box-shadow:inset 0 0 0 1px #50d89055}
    @keyframes kindroidxl-row-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    #${MODAL_ID}{position:fixed;z-index:2147483647;inset:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#f7f7fb}
    #${MODAL_ID} *{box-sizing:border-box}
    #${MODAL_ID} .kindroidxl-backdrop{position:absolute;inset:0;background:radial-gradient(circle at 50% 35%,#604bcc33,transparent 42%),#06060ac7;backdrop-filter:blur(12px);animation:kindroidxl-fade .2s both}
    #${MODAL_ID} .kindroidxl-dialog{position:absolute;left:50%;top:50%;width:min(590px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;transform:translate(-50%,-50%);padding:34px;border:1px solid #ffffff1f;border-radius:28px;background:linear-gradient(145deg,#1b1a25f8,#0d0d13fc 62%);box-shadow:0 35px 100px #000c,0 0 0 1px #8c78ff12;animation:kindroidxl-pop .42s cubic-bezier(.16,1,.3,1) both}
    #${MODAL_ID}.kindroidxl-closing{pointer-events:none;opacity:0;transition:opacity .18s}
    #${MODAL_ID} .kindroidxl-close{position:absolute;right:18px;top:16px;width:40px;height:40px;border:1px solid #ffffff12;border-radius:50%;background:#ffffff08;color:#aaa8b4;font:300 25px/1 sans-serif;cursor:pointer}
    #${MODAL_ID} .kindroidxl-close:hover{color:#fff;background:#ffffff12}
    #${MODAL_ID} .kindroidxl-brand{display:flex;align-items:center;gap:10px;color:#a99bff;font:800 11px/1 sans-serif;letter-spacing:.19em}
    #${MODAL_ID} .kindroidxl-mark{display:grid;place-items:center;width:34px;height:34px;border:1px solid #9e8aff88;border-radius:10px;background:linear-gradient(135deg,#a991ff,#6b53de);color:#fff;font-size:11px;letter-spacing:0;box-shadow:0 8px 25px #765fe755}
    #${MODAL_ID} h2{margin:24px 0 8px;color:#fff;font-size:30px;line-height:1.12;letter-spacing:-.035em}
    #${MODAL_ID} .kindroidxl-intro{margin:0 0 26px;color:#9b99a8;font-size:14px;line-height:1.55}
    #${MODAL_ID} .kindroidxl-pair{display:grid;grid-template-columns:1fr 1fr;gap:13px}
    #${MODAL_ID} label{display:block;margin:0 0 16px;color:#b8b6c2;font-size:11px;font-weight:750;letter-spacing:.04em}
    #${MODAL_ID} input[type=text],#${MODAL_ID} input[type=password]{display:block;width:100%;height:50px;margin-top:8px;padding:0 15px;border:1px solid #ffffff1c;border-radius:13px;outline:0;background:#08080dcc;color:#fff;font:500 14px/1 sans-serif;transition:.2s}
    #${MODAL_ID} input:focus{border-color:#9d89ff;box-shadow:0 0 0 4px #8c76ff1d}
    #${MODAL_ID} .kindroidxl-token{position:relative}#${MODAL_ID} .kindroidxl-token input{padding-right:66px}
    #${MODAL_ID} .kindroidxl-reveal{position:absolute;right:8px;top:15px;height:36px;border:0;background:transparent;color:#9c8bff;font:750 11px/1 sans-serif;cursor:pointer}
    #${MODAL_ID} .kindroidxl-remember{display:flex;align-items:center;gap:11px;margin:4px 0 20px;cursor:pointer;letter-spacing:0}
    #${MODAL_ID} .kindroidxl-remember input{position:absolute;opacity:0}
    #${MODAL_ID} .kindroidxl-remember>span:first-of-type{position:relative;flex:0 0 38px;height:22px;border:1px solid #ffffff24;border-radius:99px;background:#ffffff0d;transition:.25s}
    #${MODAL_ID} .kindroidxl-remember>span:first-of-type:after{content:'';position:absolute;left:3px;top:3px;width:14px;height:14px;border-radius:50%;background:#777481;transition:.25s}
    #${MODAL_ID} .kindroidxl-remember input:checked+span{border-color:#9e8aff;background:#846fec55}#${MODAL_ID} .kindroidxl-remember input:checked+span:after{left:19px;background:#b7aaff;box-shadow:0 0 10px #9f8bff}
    #${MODAL_ID} .kindroidxl-remember strong,#${MODAL_ID} .kindroidxl-remember small{display:block}#${MODAL_ID} .kindroidxl-remember small{margin-top:3px;color:#777582;font-weight:500}
    #${MODAL_ID} .kindroidxl-connect{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:52px;border:0;border-radius:14px;background:linear-gradient(115deg,#a28dff,#745bdd);color:#fff;box-shadow:0 12px 30px #7157d93d;cursor:pointer;font:800 13px/1 sans-serif;letter-spacing:.02em;transition:.2s}
    #${MODAL_ID} .kindroidxl-connect:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.08)}#${MODAL_ID} .kindroidxl-connect:disabled{cursor:wait;opacity:.85}
    #${MODAL_ID} .kindroidxl-spinner{display:none;width:17px;height:17px;border:2px solid #ffffff55;border-top-color:#fff;border-radius:50%;animation:kindroidxl-spin .7s linear infinite}#${MODAL_ID} .is-loading .kindroidxl-spinner{display:block}
    #${MODAL_ID} .kindroidxl-status{min-height:20px;margin-top:11px;color:#8f8c9d;text-align:center;font-size:12px;line-height:1.4}#${MODAL_ID} .kindroidxl-status.is-error{color:#ff9baf}
    #${MODAL_ID} form.is-complete{display:none}
    #${MODAL_ID} .kindroidxl-success{display:none;padding:25px 0 5px;text-align:center}#${MODAL_ID} .kindroidxl-success.is-visible{display:block;animation:kindroidxl-rise .5s .05s both}
    #${MODAL_ID} .kindroidxl-orbit{position:relative;display:grid;place-items:center;width:118px;height:118px;margin:2px auto 28px;border:1px solid #72e6b23d;border-radius:50%;background:radial-gradient(circle,#5ee5ac25,transparent 66%)}
    #${MODAL_ID} .kindroidxl-orbit:before,#${MODAL_ID} .kindroidxl-orbit:after{content:'';position:absolute;inset:10px;border:1px solid #75edb84d;border-radius:50%;animation:kindroidxl-ring 1.8s ease-out infinite}#${MODAL_ID} .kindroidxl-orbit:after{animation-delay:.6s}
    #${MODAL_ID} .kindroidxl-orbit i{position:absolute;inset:-4px;border-radius:50%;border-top:2px solid #7bf0bb;animation:kindroidxl-spin 1.3s linear infinite}
    #${MODAL_ID} .kindroidxl-orbit b{display:grid;place-items:center;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#75ebb6,#39b982);color:#071f16;font-size:29px;box-shadow:0 0 38px #55dba278}
    #${MODAL_ID} .kindroidxl-success h3{margin:0 0 8px;color:#fff;font-size:25px}#${MODAL_ID} .kindroidxl-success p{margin:0;color:#9a98a6;font-size:14px}#${MODAL_ID} .kindroidxl-success button{margin-top:25px;min-width:150px;height:44px;border:1px solid #ffffff18;border-radius:12px;background:#ffffff0c;color:#fff;cursor:pointer;font-weight:750}
    @keyframes kindroidxl-fade{from{opacity:0}}@keyframes kindroidxl-pop{from{opacity:0;transform:translate(-50%,-47%) scale(.96)}}@keyframes kindroidxl-rise{from{opacity:0;transform:translateY(12px)}}@keyframes kindroidxl-spin{to{transform:rotate(360deg)}}@keyframes kindroidxl-ring{0%{transform:scale(.65);opacity:0}35%{opacity:1}100%{transform:scale(1.25);opacity:0}}
    @media(max-width:520px){#${MODAL_ID} .kindroidxl-dialog{padding:27px 20px;border-radius:22px}#${MODAL_ID} .kindroidxl-pair{grid-template-columns:1fr}#${MODAL_ID} h2{font-size:26px}}
    @media(prefers-reduced-motion:reduce){#${MODAL_ID} *,#${ENTRY_ID}{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
  `);

  let lastUrl = location.href;
  const observer = new MutationObserver(mountSettingsEntry);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      document.getElementById(MODAL_ID)?.remove();
    }
    mountSettingsEntry();
  }, 800);
  mountSettingsEntry();
}());
