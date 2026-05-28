// ==UserScript==
// @name         Amazon Kindle Book Auto Classifier
// @namespace    http://tampermonkey.net/
// @version      3.0.0
// @description  Classify Kindle books into collections with AI, one page at a time, with auto-next-page processing
// @author       Claude
// @match        https://www.amazon.com/hz/mycd/digital-console/contentlist/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULTS = {
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4o-mini',
    systemPrompt: `You are a book classifier. Given a book's title and author, classify it into exactly ONE of the available collections.

CRITICAL RULES:
- Return ONLY valid JSON, no markdown, no code blocks, no explanations.
- Format: {"classifications":[{"index":0,"collection":"name"},{"index":1,"collection":"name"}]}
- Every book must be assigned to exactly one collection from the provided list.
- Do not invent new collection names.
- Use 0-based index matching the book list order.
- No trailing commas, no comments in JSON.`,
    batchSize: 10,
    requestDelayMs: 3000,
    pageDelayMs: 2500,
    maxRetries: 3,
    maxTokens: 4000,
    dialogOpenTimeout: 5000,
    dialogCloseTimeout: 3000,
  };

  const AUTO_STATE_KEY = 'kc_auto_state';
  const MAX_LOGS = 200;

  let state = {
    books: [],
    unclassified: [],
    classified: [],
    collections: [],
    scanning: false,
    classifying: false,
    applying: false,
    autoRunning: false,
    progress: { current: 0, total: 0, phase: '' },
    logs: [],
  };

  function loadConfig() {
    const cfg = {};
    for (const [k, v] of Object.entries(DEFAULTS)) cfg[k] = GM_getValue(k, v);
    return cfg;
  }

  function saveConfig(cfg) {
    for (const [k, v] of Object.entries(cfg)) GM_setValue(k, v);
  }

  function loadAutoState() {
    const raw = GM_getValue(AUTO_STATE_KEY, null);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.running) return null;
      if (Date.now() - parsed.timestamp > 30 * 60 * 1000) {
        GM_setValue(AUTO_STATE_KEY, null);
        return null;
      }
      return parsed;
    } catch {
      GM_setValue(AUTO_STATE_KEY, null);
      return null;
    }
  }

  function saveAutoState(patch = {}) {
    const current = loadAutoState() || {};
    GM_setValue(AUTO_STATE_KEY, JSON.stringify({
      running: true,
      timestamp: Date.now(),
      ...current,
      ...patch,
    }));
  }

  function clearAutoState() {
    GM_setValue(AUTO_STATE_KEY, null);
  }

  function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    state.logs.push({ time, msg, type });
    if (state.logs.length > MAX_LOGS) state.logs.shift();
    renderLogs();
    console.log(`[KindleClassifier] [${type}] ${msg}`);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function updateProgress(current, total, phase) {
    state.progress = { current, total, phase };
    renderProgress();
  }

  function getCurrentPage() {
    return parseInt(new URLSearchParams(window.location.search).get('pageNumber'), 10) || 1;
  }

  function getTotalPages() {
    let maxPage = 1;
    document.querySelectorAll('[class*="pagination"] a, [class*="pagination"] button, [class*="page-number"]')
      .forEach(el => {
        const n = parseInt(el.textContent.trim(), 10);
        if (!Number.isNaN(n) && n > maxPage) maxPage = n;
      });
    const bodyMatch = document.body.textContent.match(/Page\s+\d+\s+of\s+(\d+)/i);
    if (bodyMatch) maxPage = Math.max(maxPage, parseInt(bodyMatch[1], 10));
    return maxPage;
  }

  function getNextPageUrl() {
    const current = getCurrentPage();
    const total = getTotalPages();
    if (current >= total) return null;
    const url = new URL(window.location.href);
    url.searchParams.set('pageNumber', String(current + 1));
    return url.toString();
  }

  function parseBooksFromDocument(doc) {
    const books = [];
    const containers = doc.querySelectorAll('[class*="DigitalEntitySummary-module__container"]');
    containers.forEach(container => parseBookRow(container, books));
    return books;
  }

  function parseBookRow(container, books) {
    try {
      let asin = null;
      const imgContainer = container.querySelector('[id^="content-image-"]');
      if (imgContainer) asin = imgContainer.id.replace('content-image-', '');
      if (!asin) {
        const cb = container.querySelector('input[type="checkbox"]');
        if (cb && cb.id) {
          const parts = cb.id.split(':');
          if (parts.length >= 2) asin = parts[0];
        }
      }
      if (!asin) return;

      const titleEl = container.querySelector('.digital_entity_title_no_link')
        || container.querySelector('[class*="title"]');
      const title = titleEl ? titleEl.textContent.trim() : '';
      if (!title || title === 'Unknown') return;

      let author = 'Unknown';
      const infoRows = container.querySelectorAll('.information_row');
      for (const row of infoRows) {
        const text = row.textContent.trim();
        if (!text) continue;
        if (/\d+\.?\d*\s*[KMGT]B/.test(text)) continue;
        if (/created on|added on/i.test(text)) continue;
        if (/^In\s+\d/i.test(text)) continue;
        if (/Collection\(s\)\s+with\s+this\s+item:/i.test(text)) continue;
        if (row.querySelector('.dropdown_count') || row.querySelector('.popover-drop-down')) continue;
        author = text;
        break;
      }

      let hasCollection = false;
      const existingCollections = [];
      const popover = container.querySelector('[id^="CollectionPopover"]');
      if (popover) {
        const names = popover.querySelectorAll('.popover-name');
        if (names.length > 0) {
          hasCollection = true;
          names.forEach(name => {
            const clean = name.textContent.trim();
            if (clean) existingCollections.push(clean);
          });
        }
      }

      if (!hasCollection) {
        const allInfoRows = container.querySelectorAll('.information_row');
        for (const row of allInfoRows) {
          const text = row.textContent.trim();
          if (!/Collection\(s\)\s+with\s+this\s+item:/i.test(text)) continue;
          hasCollection = true;
          const match = text.match(/Collection\(s\)\s+with\s+this\s+item:\s*(.+?)(?:\d+Dev|$)/i);
          if (match && match[1]) {
            match[1]
              .split(/\d+/)
              .map(name => name.trim())
              .filter(Boolean)
              .forEach(name => existingCollections.push(name));
          }
          break;
        }
      }

      books.push({ asin, title, author, hasCollection, existingCollections });
    } catch {
      // Ignore broken rows.
    }
  }

  function discoverCollections(books) {
    const names = new Set(state.collections);
    for (const book of books) {
      for (const name of book.existingCollections) {
        if (!names.has(name)) {
          names.add(name);
          log(`Discovered: "${name}"`, 'success');
        }
      }
    }
    return [...names];
  }

  function discoverFromDialog() {
    const names = new Set(state.collections);
    const dialogList = document.querySelector('[id^="AddOrRemoveFromCollection_"]');
    if (!dialogList) return state.collections;
    dialogList.querySelectorAll('[class*="action_list_value"]').forEach(el => {
      const name = el.textContent.trim();
      if (name) names.add(name);
    });
    return [...names];
  }

  async function scanCurrentPage() {
    const books = parseBooksFromDocument(document);
    log(`Scanned page ${getCurrentPage()}: ${books.length} books`, 'info');
    return books;
  }

  function processScanResults(books) {
    state.books = books;
    state.collections = discoverCollections(books);
    state.unclassified = books.filter(book => !book.hasCollection);
    state.classified = [];

    const classifiedCount = books.length - state.unclassified.length;
    log(`Page ${getCurrentPage()}: ${books.length} total, ${classifiedCount} classified, ${state.unclassified.length} unclassified`, 'success');

    if (state.collections.length === 0) {
      log('No collections discovered. Open "Add or Remove from Collection" on any book, then click Refresh.', 'warn');
    } else {
      log(`Collections (${state.collections.length}): ${state.collections.join(', ')}`, 'info');
    }

    renderAll();
  }

  function buildClassificationPrompt(books, collectionNames) {
    const payload = books.map((book, index) => ({
      index,
      title: book.title,
      author: book.author,
    }));

    return JSON.stringify({
      collections: collectionNames,
      books: payload,
      output: {
        classifications: [{ index: 0, collection: 'collection_name' }],
      },
      rules: [
        'Assign every book exactly one existing collection.',
        'Use only collection names from the provided list.',
        'Keep the original 0-based index.',
      ],
    });
  }

  async function classifyBatch(books, config) {
    const body = JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: config.systemPrompt },
        { role: 'user', content: buildClassificationPrompt(books, state.collections) },
      ],
      temperature: 0.1,
      max_tokens: config.maxTokens || DEFAULTS.maxTokens,
      response_format: { type: 'json_object' },
    });

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: config.apiEndpoint,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        data: body,
        timeout: 60000,
        onload: response => {
          if (response.status !== 200) {
            reject(new Error(`HTTP ${response.status}`));
            return;
          }
          try {
            const data = JSON.parse(response.responseText);
            const content = data.choices?.[0]?.message?.content || '';
            if (!content.trim()) {
              reject(new Error('Empty AI response'));
              return;
            }
            resolve(content);
          } catch {
            reject(new Error('API response parse error'));
          }
        },
        onerror: error => reject(error),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  function parseClassificationResponse(text, batch) {
    let raw = text.trim();
    const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) raw = codeBlock[1].trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('AI returned invalid JSON');
    }

    const items = Array.isArray(parsed.classifications) ? parsed.classifications : [];
    if (items.length !== batch.length) {
      throw new Error(`AI returned ${items.length} items for ${batch.length} books`);
    }

    const seenIndexes = new Set();
    const results = [];
    for (const item of items) {
      const index = Number(item.index);
      const collectionName = typeof item.collection === 'string' ? item.collection.trim() : '';

      if (!Number.isInteger(index) || index < 0 || index >= batch.length) {
        throw new Error(`Invalid index from AI: ${item.index}`);
      }
      if (seenIndexes.has(index)) {
        throw new Error(`Duplicate index from AI: ${index}`);
      }
      if (!state.collections.includes(collectionName)) {
        throw new Error(`Unknown collection from AI: "${collectionName}"`);
      }

      seenIndexes.add(index);
      const book = batch[index];
      results.push({
        asin: book.asin,
        title: book.title,
        author: book.author,
        collectionName,
      });
    }

    return results;
  }

  async function classifyBooks(books, config) {
    const batchSize = config.batchSize || DEFAULTS.batchSize;
    const results = [];
    const totalBatches = Math.ceil(books.length / batchSize);

    for (let i = 0; i < books.length; i += batchSize) {
      const batchNumber = Math.floor(i / batchSize) + 1;
      const batch = books.slice(i, i + batchSize);
      updateProgress(batchNumber, totalBatches, 'AI classifying');
      log(`Batch ${batchNumber}/${totalBatches}: ${batch.length} books`, 'info');

      let lastError = null;
      for (let attempt = 0; attempt < config.maxRetries; attempt++) {
        try {
          const response = await classifyBatch(batch, config);
          results.push(...parseClassificationResponse(response, batch));
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          log(`Batch ${batchNumber} attempt ${attempt + 1} failed: ${error.message}`, 'warn');
          if (attempt < config.maxRetries - 1) await sleep(config.requestDelayMs);
        }
      }

      if (lastError) throw lastError;
      if (i + batchSize < books.length) await sleep(config.requestDelayMs);
    }

    return results;
  }

  function findBookRow(asin) {
    const img = document.getElementById(`content-image-${asin}`);
    return img ? img.closest('[class*="DigitalEntitySummary-module__container"]') : null;
  }

  function isDialogVisible(dialog) {
    return dialog && !dialog.classList.contains('DeviceDialogBox-module_container_hidden__2p01k');
  }

  async function waitFor(fn, timeout = 5000, interval = 200) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = fn();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  async function applyOneBook(book, attempt = 0) {
    const maxAttempts = 3;
    log(`[${attempt + 1}/${maxAttempts}] "${book.title}" -> "${book.collectionName}"`, 'info');

    try {
      const row = findBookRow(book.asin);
      if (!row) throw new Error('Row not found on page');

      const moreBtn = row.querySelector('[id^="MORE_ACTION:"]');
      if (!moreBtn) throw new Error('More Actions button not found');
      const wasExpanded = moreBtn.getAttribute('aria-expanded') === 'true';
      if (!wasExpanded) {
        moreBtn.click();
        await sleep(600);
      }

      const actionBtn = document.getElementById(`ADD_OR_REMOVE_FROM_COLLECTION_ACTION_${book.asin}`);
      if (!actionBtn) {
        if (!wasExpanded) moreBtn.click();
        throw new Error('Collection action not found');
      }
      actionBtn.click();

      const dialog = await waitFor(() => {
        const el = document.querySelector(`[id^="ADD_OR_REMOVE_FROM_COLLECTION_DIALOG_${book.asin}"]`);
        return isDialogVisible(el) ? el : null;
      }, DEFAULTS.dialogOpenTimeout);
      if (!dialog) throw new Error('Dialog did not open');

      const list = document.getElementById(`AddOrRemoveFromCollection_${book.asin}`);
      if (!list) throw new Error('Collection list not found');

      let found = false;
      for (const item of list.querySelectorAll('li')) {
        const nameEl = item.querySelector('[class*="action_list_value"]');
        if (!nameEl || nameEl.textContent.trim() !== book.collectionName) continue;
        const checkbox = item.querySelector('[role="checkbox"]');
        if (!checkbox) continue;
        if (checkbox.getAttribute('aria-checked') !== 'true') {
          checkbox.click();
          await sleep(300);
        }
        found = true;
        break;
      }
      if (!found) throw new Error(`Collection "${book.collectionName}" not available in dialog`);

      const confirmBtn = await waitFor(() => {
        const btn = document.getElementById(`ADD_OR_REMOVE_FROM_COLLECTION_ACTION_${book.asin}_CONFIRM`);
        return btn && btn.getAttribute('aria-disabled') === 'false' ? btn : null;
      }, 5000, 250);
      if (!confirmBtn) throw new Error('"Make Changes" button never enabled');

      confirmBtn.click();

      const closed = await waitFor(() => {
        const el = document.querySelector(`[id^="ADD_OR_REMOVE_FROM_COLLECTION_DIALOG_${book.asin}"]`);
        return !el || !isDialogVisible(el);
      }, DEFAULTS.dialogCloseTimeout);
      if (!closed) log('Dialog may not have closed cleanly', 'warn');

      const successNotification = document.getElementById('notification-success');
      if (successNotification && successNotification.hasAttribute('open')) {
        const closeBtn = document.getElementById('notification-close');
        if (closeBtn) closeBtn.click();
      }

      log(`Applied: "${book.title}" -> "${book.collectionName}"`, 'success');
      return true;
    } catch (error) {
      try {
        const cancelBtn = document.getElementById(`ADD_OR_REMOVE_FROM_COLLECTION_ACTION_${book.asin}_CANCEL`);
        if (cancelBtn) cancelBtn.click();
      } catch {
        // Ignore cleanup failures.
      }

      if (attempt < maxAttempts - 1) {
        log(`Retrying after error: ${error.message}`, 'warn');
        await sleep(1500);
        return applyOneBook(book, attempt + 1);
      }

      log(`Failed: ${error.message}`, 'error');
      return false;
    }
  }

  async function applyClassifications(classified) {
    let ok = 0;
    let fail = 0;

    for (let i = 0; i < classified.length; i++) {
      updateProgress(i + 1, classified.length, 'Applying');
      const applied = await applyOneBook(classified[i]);
      if (applied) ok++;
      else fail++;
      if (i < classified.length - 1) await sleep(1000 + Math.random() * 1000);
    }

    return { ok, fail };
  }

  async function goToNextPageOrStop(reason) {
    const nextUrl = getNextPageUrl();
    if (!nextUrl) {
      log(reason || 'Last page reached. Auto mode stopped.', 'success');
      stopAutoProcess();
      return false;
    }

    saveAutoState({ lastPage: getCurrentPage() });
    log(`Moving to next page in ${Math.round((loadConfig().pageDelayMs || DEFAULTS.pageDelayMs) / 1000)}s...`, 'info');
    await sleep(loadConfig().pageDelayMs || DEFAULTS.pageDelayMs);
    window.location.href = nextUrl;
    return true;
  }

  async function runSinglePageCycle(autoMode = false) {
    const cfg = loadConfig();
    if (!cfg.apiKey || cfg.apiKey.length < 10) throw new Error('Set a valid API key first');

    state.scanning = true;
    updateButtonStates();
    const books = await scanCurrentPage();
    processScanResults(books);
    state.scanning = false;

    if (state.unclassified.length === 0) {
      log('No unclassified books on this page', 'info');
      if (autoMode) await goToNextPageOrStop('No more unclassified books. Auto mode finished.');
      return;
    }

    if (state.collections.length === 0) {
      throw new Error('No collections discovered. Open a collection dialog once and click Refresh.');
    }

    state.classifying = true;
    updateButtonStates();
    log(`Classifying ${state.unclassified.length} books on page ${getCurrentPage()}...`, 'info');
    state.classified = await classifyBooks(state.unclassified, cfg);
    state.classifying = false;
    renderAll();

    const valid = state.classified.filter(item => state.collections.includes(item.collectionName));
    if (valid.length === 0) throw new Error('AI produced no valid classifications');

    state.applying = true;
    updateButtonStates();
    log(`Applying ${valid.length} books on page ${getCurrentPage()}...`, 'warn');
    const result = await applyClassifications(valid);
    state.applying = false;
    updateProgress(0, 0, '');
    updateButtonStates();

    log(`Page ${getCurrentPage()} done: ${result.ok} applied, ${result.fail} failed`, result.fail ? 'warn' : 'success');

    if (autoMode) {
      await goToNextPageOrStop('Reached last page. Auto mode finished.');
      return;
    }

    await sleep(1200);
    processScanResults(await scanCurrentPage());
  }

  async function resumeAutoProcessIfNeeded() {
    const autoState = loadAutoState();
    if (!autoState) return;

    state.autoRunning = true;
    updateButtonStates();
    log(`Auto mode resumed on page ${getCurrentPage()}`, 'info');

    const pageReady = await waitFor(() => {
      const containers = document.querySelectorAll('[class*="DigitalEntitySummary-module__container"]');
      return containers.length > 0 ? true : null;
    }, 10000, 300);

    if (!pageReady) {
      log('Page content did not load in time. Auto mode stopped.', 'error');
      stopAutoProcess();
      return;
    }

    try {
      await runSinglePageCycle(true);
    } catch (error) {
      log(`Auto mode stopped: ${error.message}`, 'error');
      stopAutoProcess();
    }
  }

  function startAutoProcess() {
    const cfg = readConfigFromUI();
    saveConfig(cfg);
    saveAutoState({ startedAt: Date.now(), lastPage: getCurrentPage() });
    state.autoRunning = true;
    updateButtonStates();
    runSinglePageCycle(true).catch(error => {
      log(`Auto mode stopped: ${error.message}`, 'error');
      stopAutoProcess();
    });
  }

  function stopAutoProcess() {
    clearAutoState();
    state.autoRunning = false;
    state.scanning = false;
    state.classifying = false;
    state.applying = false;
    updateProgress(0, 0, '');
    updateButtonStates();
  }

  function injectStyles() {
    GM_addStyle(`
#kc-panel{position:fixed;top:10px;right:10px;width:430px;max-height:calc(100vh - 20px);background:#fff;border:2px solid #ff9900;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.2);z-index:99999;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;overflow:hidden}
#kc-panel.minimized #kc-body,#kc-panel.minimized #kc-footer{display:none}
#kc-header{background:linear-gradient(135deg,#232f3e,#37475a);color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;flex-shrink:0}
#kc-header h3{margin:0;font-size:14px;font-weight:600}
#kc-header .kc-btns{display:flex;gap:6px}
#kc-header .kc-btns button{background:rgba(255,255,255,.2);border:none;color:#fff;cursor:pointer;width:26px;height:26px;border-radius:4px;font-size:14px;line-height:26px;text-align:center;padding:0}
#kc-body{flex:1;overflow-y:auto;padding:10px 14px}
#kc-body section{margin-bottom:10px}
#kc-body h4{margin:0 0 4px;font-size:11px;text-transform:uppercase;color:#555;border-bottom:1px solid #eee;padding-bottom:3px}
#kc-body label{display:block;font-size:11px;color:#666;margin-top:4px;margin-bottom:1px}
#kc-body input[type=text],#kc-body input[type=password],#kc-body input[type=number],#kc-body textarea{width:100%;box-sizing:border-box;padding:5px 7px;font-size:12px;border:1px solid #ccc;border-radius:3px;font-family:inherit}
#kc-body textarea{resize:vertical;min-height:50px}
.kc-btn{display:inline-block;padding:7px 14px;border:none;border-radius:4px;font-size:12px;cursor:pointer;font-weight:500}
.kc-btn:disabled{opacity:.5;cursor:not-allowed}
.kc-btn-primary{background:#ff9900;color:#111}
.kc-btn-primary:hover:not(:disabled){background:#e8890b}
.kc-btn-secondary{background:#e7e9ec;color:#111}
.kc-btn-secondary:hover:not(:disabled){background:#d5d9db}
.kc-btn-danger{background:#d13212;color:#fff}
.kc-btn-sm{padding:3px 8px;font-size:11px}
#kc-footer{border-top:1px solid #eee;padding:8px 14px;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0}
.kc-progress{background:#f0f0f0;border-radius:3px;height:5px;margin:3px 0;overflow:hidden}
.kc-progress-bar{height:100%;background:#ff9900;transition:width .3s}
.kc-log-entry{font-size:10px;padding:1px 0;border-bottom:1px solid #f5f5f5;line-height:1.3;word-break:break-all}
.kc-log-entry.info{color:#333}.kc-log-entry.success{color:#067d62}.kc-log-entry.warn{color:#c45500}.kc-log-entry.error{color:#d13212}
.kc-log-time{color:#999;margin-right:4px}
#kc-logs{max-height:120px;overflow-y:auto;background:#fafafa;padding:2px 4px;border-radius:3px}
.kc-config-row{display:flex;gap:6px}.kc-config-row>*{flex:1}
.kc-book-item{display:flex;align-items:center;gap:4px;padding:2px 0;font-size:11px}
.kc-book-title{font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kc-book-author{color:#666;font-size:10px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kc-book-result{font-size:11px;color:#067d62;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kc-collapsible-content{display:none}.kc-collapsible-content.open{display:block}
.kc-collapse-toggle{cursor:pointer;color:#0066c0;font-size:11px}
.kc-stats{display:flex;gap:10px;font-size:11px}
.kc-stat{background:#f0f0f0;padding:3px 8px;border-radius:10px}
.kc-stat-val{font-weight:700;color:#ff9900}
.kc-tags{display:flex;flex-wrap:wrap;gap:3px;margin-top:2px}
.kc-tag{background:#e8f0fe;color:#1967d2;padding:1px 6px;border-radius:8px;font-size:10px}
`);
  }

  function renderAll() {
    renderBookList();
    renderResults();
    renderCollections();
    updateStats();
    updateButtonStates();
  }

  function renderBookList() {
    const container = document.getElementById('kc-book-list');
    if (state.unclassified.length === 0) {
      container.innerHTML = '<span style="color:#999;font-size:12px;">No unclassified books on this page</span>';
      return;
    }
    container.innerHTML = state.unclassified.map(book =>
      `<div class="kc-book-item"><span class="kc-book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</span><span class="kc-book-author" title="${escapeHtml(book.author)}">${escapeHtml(book.author)}</span></div>`
    ).join('');
  }

  function renderResults() {
    const section = document.getElementById('kc-results-section');
    const container = document.getElementById('kc-results-list');
    if (state.classified.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';
    container.innerHTML = state.classified.map(book =>
      `<div class="kc-book-item"><span class="kc-book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</span><span>→</span><span class="kc-book-result">${escapeHtml(book.collectionName)}</span></div>`
    ).join('');
  }

  function renderCollections() {
    const container = document.getElementById('kc-collections-list');
    if (state.collections.length === 0) {
      container.innerHTML = '<span style="color:#999;font-size:11px;">None. Open "Add or Remove from Collection" on any book, then Refresh.</span>';
      return;
    }
    container.innerHTML = `<div class="kc-tags">${state.collections.map(name => `<span class="kc-tag">${escapeHtml(name)}</span>`).join('')}</div>`;
  }

  function renderProgress() {
    const container = document.getElementById('kc-progress-container');
    if (state.progress.total === 0) {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'block';
    const pct = Math.round((state.progress.current / state.progress.total) * 100);
    document.getElementById('kc-progress-text').textContent = `${state.progress.phase}: ${state.progress.current}/${state.progress.total} (${pct}%)`;
    document.getElementById('kc-progress-bar').style.width = `${pct}%`;
  }

  function renderLogs() {
    const container = document.getElementById('kc-logs');
    if (!container) return;
    container.innerHTML = state.logs.slice(-30).map(entry =>
      `<div class="kc-log-entry ${entry.type}"><span class="kc-log-time">${entry.time}</span>${escapeHtml(entry.msg)}</div>`
    ).join('');
    container.scrollTop = container.scrollHeight;
  }

  function updateStats() {
    document.getElementById('kc-stat-total').textContent = String(state.books.length);
    document.getElementById('kc-stat-unclassified').textContent = String(state.unclassified.length);
    document.getElementById('kc-stat-classified').textContent = String(state.classified.length);
  }

  function updateButtonStates() {
    const busy = state.scanning || state.classifying || state.applying;
    document.getElementById('kc-scan').disabled = busy || state.autoRunning;
    document.getElementById('kc-classify').disabled = busy || state.autoRunning || state.unclassified.length === 0;
    document.getElementById('kc-apply').disabled = busy || state.autoRunning || state.classified.length === 0;
    document.getElementById('kc-auto').disabled = busy || state.autoRunning;
    document.getElementById('kc-stop-auto').disabled = !state.autoRunning;
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'kc-panel';
    panel.innerHTML = `
<div id="kc-header"><h3>Kindle Classifier</h3><div class="kc-btns"><button id="kc-minimize">_</button><button id="kc-close">×</button></div></div>
<div id="kc-body">
<section>
  <h4><span class="kc-collapse-toggle" data-target="kc-config-content">Configuration ▾</span></h4>
  <div id="kc-config-content" class="kc-collapsible-content">
    <label>API Endpoint</label><input id="kc-api-endpoint" placeholder="https://api.openai.com/v1/chat/completions">
    <label>API Key</label><div class="kc-config-row"><input type="password" id="kc-api-key" placeholder="sk-..."><button class="kc-btn kc-btn-secondary kc-btn-sm" id="kc-save-config" style="flex:0;">Save</button></div>
    <label>Model</label><input id="kc-model" placeholder="gpt-4o-mini">
    <label>Batch Size</label><input type="number" id="kc-batch-size" min="1" max="50">
    <label>Request Delay (ms)</label><input type="number" id="kc-delay" min="500" max="30000">
    <label>Next Page Delay (ms)</label><input type="number" id="kc-page-delay" min="1000" max="30000">
    <label>System Prompt</label><textarea id="kc-system-prompt" rows="3"></textarea>
  </div>
</section>
<section>
  <h4>Collections <button class="kc-btn kc-btn-secondary kc-btn-sm" id="kc-refresh-collections" style="margin-left:6px;">Refresh</button></h4>
  <div id="kc-collections-list" style="min-height:18px;"></div>
</section>
<section>
  <div class="kc-stats"><span class="kc-stat">Total: <span class="kc-stat-val" id="kc-stat-total">0</span></span><span class="kc-stat">Unclassified: <span class="kc-stat-val" id="kc-stat-unclassified">0</span></span><span class="kc-stat">Ready: <span class="kc-stat-val" id="kc-stat-classified">0</span></span></div>
  <div id="kc-progress-container" style="display:none;margin-top:6px;"><div style="font-size:10px;color:#666;" id="kc-progress-text"></div><div class="kc-progress"><div class="kc-progress-bar" id="kc-progress-bar" style="width:0;"></div></div></div>
</section>
<section>
  <h4>Unclassified Books</h4>
  <div id="kc-book-list" style="max-height:180px;overflow-y:auto;"></div>
</section>
<section id="kc-results-section" style="display:none;">
  <h4>AI Results</h4>
  <div id="kc-results-list" style="max-height:180px;overflow-y:auto;"></div>
</section>
<section><h4>Log</h4><div id="kc-logs"></div></section>
</div>
<div id="kc-footer">
  <button class="kc-btn kc-btn-primary" id="kc-scan">Scan Page</button>
  <button class="kc-btn kc-btn-primary" id="kc-classify" disabled>Classify</button>
  <button class="kc-btn kc-btn-danger" id="kc-apply" disabled>Apply</button>
  <button class="kc-btn kc-btn-secondary" id="kc-auto">Auto Process</button>
  <button class="kc-btn kc-btn-secondary" id="kc-stop-auto" disabled>Stop Auto</button>
</div>`;
    document.body.appendChild(panel);
  }

  function setupEvents() {
    document.getElementById('kc-minimize').onclick = () => document.getElementById('kc-panel').classList.toggle('minimized');

    document.getElementById('kc-close').onclick = () => {
      document.getElementById('kc-panel').style.display = 'none';
      if (!document.getElementById('kc-reopen')) {
        const reopen = document.createElement('div');
        reopen.id = 'kc-reopen';
        reopen.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:#ff9900;color:#111;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;';
        reopen.textContent = 'KC';
        reopen.onclick = () => {
          document.getElementById('kc-panel').style.display = 'flex';
          reopen.remove();
        };
        document.body.appendChild(reopen);
      }
    };

    document.querySelectorAll('.kc-collapse-toggle').forEach(toggle => {
      toggle.onclick = () => {
        const target = document.getElementById(toggle.dataset.target);
        target.classList.toggle('open');
        toggle.textContent = toggle.textContent.replace(target.classList.contains('open') ? '▸' : '▾', target.classList.contains('open') ? '▾' : '▸');
      };
    });

    document.getElementById('kc-save-config').onclick = () => {
      saveConfigFromUI();
      log('Config saved', 'success');
    };

    document.getElementById('kc-refresh-collections').onclick = () => {
      const names = discoverFromDialog();
      if (names.length === 0) {
        log('No open collection dialog found', 'warn');
        return;
      }
      state.collections = names;
      renderCollections();
      log(`Collections refreshed: ${names.length}`, 'success');
    };

    document.getElementById('kc-scan').onclick = async () => {
      if (state.scanning || state.autoRunning) return;
      state.scanning = true;
      updateButtonStates();
      try {
        processScanResults(await scanCurrentPage());
      } catch (error) {
        log(`Scan failed: ${error.message}`, 'error');
      } finally {
        state.scanning = false;
        updateButtonStates();
      }
    };

    document.getElementById('kc-classify').onclick = async () => {
      if (state.classifying || state.autoRunning) return;
      const cfg = readConfigFromUI();
      if (!cfg.apiKey || cfg.apiKey.length < 10) {
        log('Set a valid API key first', 'error');
        return;
      }
      if (state.collections.length === 0) {
        log('No collections. Open a dialog once and click Refresh.', 'error');
        return;
      }

      saveConfig(cfg);
      state.classifying = true;
      updateButtonStates();
      try {
        state.classified = await classifyBooks(state.unclassified, cfg);
        log(`Classification complete: ${state.classified.length} books`, 'success');
        renderAll();
      } catch (error) {
        log(`Classify failed: ${error.message}`, 'error');
      } finally {
        state.classifying = false;
        updateButtonStates();
      }
    };

    document.getElementById('kc-apply').onclick = async () => {
      if (state.applying || state.autoRunning) return;
      if (state.classified.length === 0) {
        log('Nothing to apply', 'warn');
        return;
      }

      state.applying = true;
      updateButtonStates();
      try {
        const result = await applyClassifications(state.classified);
        log(`Apply done: ${result.ok} ok, ${result.fail} failed`, result.fail ? 'warn' : 'success');
        await sleep(1200);
        processScanResults(await scanCurrentPage());
      } catch (error) {
        log(`Apply failed: ${error.message}`, 'error');
      } finally {
        state.applying = false;
        updateProgress(0, 0, '');
        updateButtonStates();
      }
    };

    document.getElementById('kc-auto').onclick = () => {
      if (state.autoRunning) return;
      startAutoProcess();
    };

    document.getElementById('kc-stop-auto').onclick = () => {
      stopAutoProcess();
      log('Auto mode stopped by user', 'warn');
    };

    makeDraggable(document.getElementById('kc-panel'), document.getElementById('kc-header'));
  }

  function makeDraggable(panel, header) {
    let offsetX = 0;
    let offsetY = 0;

    header.onmousedown = event => {
      if (event.target.tagName === 'BUTTON') return;
      const rect = panel.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;

      const onMove = moveEvent => {
        panel.style.left = `${moveEvent.clientX - offsetX}px`;
        panel.style.top = `${moveEvent.clientY - offsetY}px`;
        panel.style.right = 'auto';
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      event.preventDefault();
    };
  }

  function readConfigFromUI() {
    return {
      apiEndpoint: document.getElementById('kc-api-endpoint').value.trim(),
      apiKey: document.getElementById('kc-api-key').value.trim(),
      model: document.getElementById('kc-model').value.trim(),
      batchSize: parseInt(document.getElementById('kc-batch-size').value, 10) || DEFAULTS.batchSize,
      requestDelayMs: parseInt(document.getElementById('kc-delay').value, 10) || DEFAULTS.requestDelayMs,
      pageDelayMs: parseInt(document.getElementById('kc-page-delay').value, 10) || DEFAULTS.pageDelayMs,
      systemPrompt: document.getElementById('kc-system-prompt').value.trim(),
      maxRetries: DEFAULTS.maxRetries,
      maxTokens: DEFAULTS.maxTokens,
    };
  }

  function saveConfigFromUI() {
    saveConfig(readConfigFromUI());
  }

  function loadConfigToUI(cfg) {
    document.getElementById('kc-api-endpoint').value = cfg.apiEndpoint || DEFAULTS.apiEndpoint;
    document.getElementById('kc-api-key').value = cfg.apiKey || '';
    document.getElementById('kc-model').value = cfg.model || DEFAULTS.model;
    document.getElementById('kc-batch-size').value = String(cfg.batchSize || DEFAULTS.batchSize);
    document.getElementById('kc-delay').value = String(cfg.requestDelayMs || DEFAULTS.requestDelayMs);
    document.getElementById('kc-page-delay').value = String(cfg.pageDelayMs || DEFAULTS.pageDelayMs);
    document.getElementById('kc-system-prompt').value = cfg.systemPrompt || DEFAULTS.systemPrompt;
  }

  function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function init() {
    const cfg = loadConfig();
    injectStyles();
    createPanel();
    loadConfigToUI(cfg);
    setupEvents();
    renderCollections();
    updateButtonStates();

    setTimeout(async () => {
      const books = parseBooksFromDocument(document);
      if (books.length > 0) {
        log(`Auto-scanned page ${getCurrentPage()}: ${books.length} books`, 'info');
        processScanResults(books);
      }
      await resumeAutoProcessIfNeeded();
    }, 1500);

    log('Kindle Classifier v3.0.0 - single-page pipeline with auto-next-page mode', 'info');
    log('Use "Auto Process" to classify this page, apply changes, then move to the next page.', 'info');

    const debouncedSave = debounce(() => saveConfigFromUI(), 1500);
    ['kc-api-endpoint', 'kc-api-key', 'kc-model', 'kc-batch-size', 'kc-delay', 'kc-page-delay', 'kc-system-prompt']
      .forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', debouncedSave);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
