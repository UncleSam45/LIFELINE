// ==UserScript==
// @name         Kindroid Auto Start Call (LIFELINE)
// @namespace    https://github.com/unclesam45/LIFELINE
// @version      1.0.0
// @description  Automatically presses Kindroid's Start call button when it appears.
// @match        https://kindroid.ai/*
// @match        https://www.kindroid.ai/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
(function createKindroidAutoCall(global) {
  'use strict';

  const START_CALL_LABEL = 'start call';
  const RETRY_DELAY_MS = 5000;
  const SCAN_INTERVAL_MS = 750;
  const attempts = new WeakMap();
  let scanQueued = false;

  function isStartCallButton(element) {
    if (!(element instanceof global.HTMLButtonElement)) return false;
    if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
    return String(element.getAttribute('aria-label') || '').trim().toLowerCase() === START_CALL_LABEL;
  }

  function findStartCallButton() {
    // The aria-label is the stable contract. The generated CSS-module suffix
    // (for example, __lMp93) may change after any Kindroid deployment.
    const labelled = [...document.querySelectorAll('button[aria-label]')].find(isStartCallButton);
    if (labelled) return labelled;
    return [...document.querySelectorAll('button[class*="call-preview-overlay-v2_call-button__"]')]
      .find(isStartCallButton) || null;
  }

  function pressStartCall() {
    const button = findStartCallButton();
    if (!button) return false;

    const now = Date.now();
    if (now - (attempts.get(button) || 0) < RETRY_DELAY_MS) return false;
    attempts.set(button, now);
    global.HTMLElement.prototype.click.call(button);
    return true;
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    global.setTimeout(() => {
      scanQueued = false;
      pressStartCall();
    }, 0);
  }

  function start() {
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      return;
    }
    queueScan();
    new MutationObserver(queueScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'aria-disabled', 'disabled'],
    });
    global.setInterval(pressStartCall, SCAN_INTERVAL_MS);
  }

  const api = Object.freeze({ findStartCallButton, pressStartCall });
  global.LifelineKindroidAutoCall = api;
  start();
})(window);
