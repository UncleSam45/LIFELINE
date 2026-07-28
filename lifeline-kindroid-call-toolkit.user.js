// ==UserScript==
// @name         Kindroid Inline Replies (LIFELINE)
// @namespace    https://github.com/unclesam45/LIFELINE
// @version      2.1.0
// @description  Collapsible quick-reply sidebar with user-defined presets for Kindroid calls.
// @match        https://kindroid.ai/call*
// @match        https://kindroid.ai/groupchat/*/call*
// @match        https://kindroid.ai/v2/call/*
// @match        https://www.kindroid.ai/call*
// @match        https://www.kindroid.ai/groupchat/*/call*
// @match        https://www.kindroid.ai/v2/call/*
// @require      https://raw.githubusercontent.com/unclesam45/LIFELINE/main/kindroid-call-toolkit.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

window.LifelineKindroidToolkit?.mount();
