// ==UserScript==
// @name         Amazon Kindle Book Auto Classifier
// @namespace    http://tampermonkey.net/
// @version      2.6.0
// @description  Auto-classify unclassified Kindle books into collections using AI API, via UI simulation
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

  // ======================== CONFIGURATION ========================
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
    pageDelayMs: 2000,
    maxRetries: 3,
    maxTokens: 4000,  // Increased for longer responses
    dialogOpenTimeout: 5000,
    dialogCloseTimeout: 8000,
  };

  // ======================== STATE ========================
  let state = {
    books: [],
    unclassified: [],
    classified: [],
    collections: [],
    scanning: false,
    classifying: false,
    applying: false,
    progress: { current: 0, total: 0, phase: '' },
    logs: [],
  };

  // ======================== STORAGE HELPERS ========================
  function loadConfig() {
    const cfg = {};
    for (const [k, v] of Object.entries(DEFAULTS)) cfg[k] = GM_getValue(k, v);
    return cfg;
  }
  function saveConfig(cfg) {
    for (const [k, v] of Object.entries(cfg)) GM_setValue(k, v);
  }

  // ======================== LOGGING ========================
  function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    state.logs.push({ time, msg, type });
    if (state.logs.length > 200) state.logs.shift();
    renderLogs();
    console.log(`[KindleClassifier] [${type}] ${msg}`);
  }

  // ======================== UTILITIES ========================
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
  function updateProgress(current, total, phase) { state.progress = { current, total, phase }; renderProgress(); }

  // ======================== DOM PARSING ========================
  function parseBooksFromDocument(doc) {
    const books = [];
    const containers = doc.querySelectorAll('[class*="DigitalEntitySummary-module__container"]');
    containers.forEach(c => parseBookRow(c, books));
    return books;
  }

  function parseBookRow(container, books) {
    try {
      // --- ASIN ---
      let asin = null;
      const imgContainer = container.querySelector('[id^="content-image-"]');
      if (imgContainer) asin = imgContainer.id.replace('content-image-', '');
      if (!asin) {
        const cb = container.querySelector('input[type="checkbox"]');
        if (cb && cb.id) { const p = cb.id.split(':'); if (p.length >= 2) asin = p[0]; }
      }
      if (!asin) return;

      // --- Title ---
      const titleEl = container.querySelector('.digital_entity_title_no_link')
        || container.querySelector('[class*="title"]');
      const title = titleEl ? titleEl.textContent.trim() : '';
      if (!title || title === 'Unknown') return;

      // --- Author ---
      let author = 'Unknown';
      const infoRows = container.querySelectorAll('.information_row');
      for (const row of infoRows) {
        const text = row.textContent.trim();
        if (/\d+\.?\d*\s*[KMGT]B/.test(text)) continue;
        if (/created on|added on/i.test(text)) continue;
        if (/^In\s+\d/i.test(text)) continue;
        // Also skip the nested dropdown_count / popover row
        if (row.querySelector('.dropdown_count') || row.querySelector('.popover-drop-down')) continue;
        author = text;
        break;
      }

      // --- hasCollection (RELIABLE: check for "Collection(s) with this item:") ---
      let hasCollection = false;
      const existingCollections = [];

      // Method 1: check if popover lists any collection names
      const popover = container.querySelector('[id^="CollectionPopover"]');
      if (popover) {
        const names = popover.querySelectorAll('.popover-name');
        if (names.length > 0) {
          hasCollection = true;
          names.forEach(n => existingCollections.push(n.textContent.trim()));
        }
      }

      // Method 2: check ALL information_row for "Collection(s) with this item:"
      // This is the MOST RELIABLE method because:
      // - Unclassified: "In1DeviceDevice(s) with this item:..."
      // - Classified: "In1CollectionCollection(s) with this item:...1DeviceDevice(s)..."
      if (!hasCollection) {
        const allInfoRows = container.querySelectorAll('.information_row');
        for (const row of allInfoRows) {
          const text = row.textContent.trim();
          if (/Collection\(s\)\s+with\s+this\s+item:/i.test(text)) {
            hasCollection = true;
            // Try to extract collection names from the text
            const match = text.match(/Collection\(s\)\s+with\s+this\s+item:\s*(.+?)(?:\d+Dev|$)/i);
            if (match && match[1]) {
              const names = match[1].split(/\d+/).filter(n => n.trim());
              names.forEach(n => existingCollections.push(n.trim()));
            }
            break;
          }
        }
      }

      // NOTE: We do NOT check dropdown_count because it can be "1" for devices too!

      // Debug: log detection
      if (!hasCollection) {
        console.log(`[KindleClassifier] UNCLASSIFIED: "${title}" (${asin})`);
      }

      books.push({ asin, title, author, hasCollection, existingCollections });
    } catch (e) { /* skip */ }
  }

  // ======================== COLLECTION DISCOVERY ========================
  function discoverCollections(books) {
    const names = new Set(state.collections);
    let changed = false;
    for (const b of books) {
      for (const n of b.existingCollections) {
        if (!names.has(n)) { names.add(n); changed = true; log(`Discovered: "${n}"`, 'success'); }
      }
    }
    return changed ? [...names] : state.collections;
  }

  /**
   * Discover collections from ANY open "Add or Remove from Collection" dialog.
   * This is the most reliable way and doesn't need any book to be classified.
   */
  function discoverFromDialog() {
    const names = new Set(state.collections);
    const dialogList = document.querySelector('[id^="AddOrRemoveFromCollection_"]');
    if (!dialogList) return state.collections;

    dialogList.querySelectorAll('[class*="action_list_value"]').forEach(el => {
      const n = el.textContent.trim();
      if (n) names.add(n);
    });

    return [...names];
  }

  // ======================== PAGE SCANNING ========================
  function getTotalPages() {
    let maxPage = 1;
    document.querySelectorAll('[class*="pagination"] a, [class*="pagination"] button, [class*="page-number"]')
      .forEach(l => { const n = parseInt(l.textContent.trim()); if (!isNaN(n) && n > maxPage) maxPage = n; });
    const m = document.body.textContent.match(/Page\s+\d+\s+of\s+(\d+)/i);
    if (m) maxPage = Math.max(maxPage, parseInt(m[1]));
    return maxPage;
  }

  async function fetchPageHtml(pageNum) {
    const url = new URL(window.location.href);
    url.searchParams.set('pageNumber', pageNum);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: url.toString(),
        headers: { 'Accept': 'text/html,application/xhtml+xml' },
        onload: r => r.status === 200 ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`)),
        onerror: e => reject(e), ontimeout: () => reject(new Error('Timeout')), timeout: 15000,
      });
    });
  }

  async function scanCurrentPage() {
    const books = parseBooksFromDocument(document);
    log(`Scanned current page: ${books.length} books`, 'info');
    return books;
  }

  async function scanAllPages() {
    const totalPages = getTotalPages();
    const currentPage = parseInt(new URLSearchParams(window.location.search).get('pageNumber')) || 1;


    if (totalPages === 1) {
      log('Only 1 page detected, scanning current page...', 'info');
      return parseBooksFromDocument(document);
    }

    log(`Detected ${totalPages} page(s). Multi-page scan requires navigation.`, 'info');
    log(`Current page: ${currentPage}. Will navigate through all pages.`, 'info');

    // Store current page books
    let allBooks = [];
    const seenAsins = new Set();
    parseBooksFromDocument(document).forEach(b => { seenAsins.add(b.asin); allBooks.push(b); });
    log(`Page ${currentPage}: ${allBooks.length} books`, 'info');

    // Save state before navigation
    const newState = {
      totalPages,
      currentPage,
      allBooks,
      seenAsins: [...seenAsins],
      scanning: true,
      timestamp: Date.now()
    };
    GM_setValue('kc_scan_state', JSON.stringify(newState));

    // Navigate to next page
    const nextPage = currentPage === 1 ? 2 : (currentPage < totalPages ? currentPage + 1 : 1);
    if (nextPage !== currentPage) {
      log(`Navigating to page ${nextPage}...`, 'info');
      await sleep(1000);
      const url = new URL(window.location.href);
      url.searchParams.set('pageNumber', nextPage);
      window.location.href = url.toString();
    }

    return allBooks;
  }

  // ======================== AI CLASSIFICATION ========================
  function buildClassificationPrompt(books, collectionNames) {
    const bookList = books.map((b, i) => `${i}. "${b.title}" by ${b.author}`).join('\n');
    const cols = collectionNames.map(c => `"${c}"`).join(', ');
    return `Available collections: [${cols}]

Books to classify:
${bookList}

Return ONLY this JSON format (no markdown, no code blocks):
{"classifications":[{"index":0,"collection":"collection_name"},{"index":1,"collection":"collection_name"}]}

Include all ${books.length} books. Use 0-based index.`;
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
      response_format: (config.model.includes('gpt-4') || config.model.includes('gpt-3.5'))
        ? { type: 'json_object' } : undefined,
    });
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url: config.apiEndpoint,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
        data: body,
        onload: r => {
          if (r.status !== 200) return reject(new Error(`HTTP ${r.status}`));
          try {
            const d = JSON.parse(r.responseText);
            const c = d.choices?.[0]?.message?.content || '';
            if (!c.trim()) return reject(new Error('Empty AI response'));
            resolve(c);
          } catch (e) { reject(new Error('Parse error')); }
        },
        onerror: e => reject(e), ontimeout: () => reject(new Error('Timeout')), timeout: 60000,
      });
    });
  }

  function parseClassificationResponse(text, batch) {
    let s = text.trim();

    // Log raw response for debugging
    console.log('[KindleClassifier] Raw AI response:', text);

    // Remove markdown code blocks
    const cb = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (cb) s = cb[1].trim();

    // Extract JSON object
    const om = s.match(/\{[\s\S]*\}/);
    if (om) s = om[0];

    // Fix common JSON errors
    s = s.replace(/,(\s*[}\]])/g, '$1');  // Remove trailing commas
    s = s.replace(/,(\s*,)/g, ',');        // Remove double commas
    s = s.replace(/\n/g, ' ');             // Remove newlines
    s = s.replace(/\s+/g, ' ');            // Normalize whitespace

    console.log('[KindleClassifier] After cleanup:', s);

    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch (e) {
      // Try to fix and parse again
      log(`JSON parse failed, attempting repair: ${e.message}`, 'warn');
      console.log('[KindleClassifier] Failed JSON:', s);

      // Try more aggressive fixes
      // Fix: {"index":0,"collection":"name"} {"index":1,...} -> add comma
      s = s.replace(/\}\s*\{/g, '},{');

      // Remove any text after the last }
      const lastBrace = s.lastIndexOf('}');
      if (lastBrace > 0) {
        s = s.substring(0, lastBrace + 1);
        console.log('[KindleClassifier] After aggressive fix:', s);
        try {
          parsed = JSON.parse(s);
          log('JSON repair successful', 'info');
        } catch (e2) {
          console.error('[KindleClassifier] Final parse error:', e2);
          throw new Error(`JSON parse failed: ${e2.message}`);
        }
      } else {
        throw new Error(`JSON parse failed: ${e.message}`);
      }
    }

    let items = parsed.classifications || parsed.results || [];
    if (!Array.isArray(items) && typeof parsed === 'object') {
      items = Object.entries(parsed)
        .filter(([k]) => !isNaN(parseInt(k)))
        .map(([k, v]) => ({ index: parseInt(k), collection: typeof v === 'string' ? v : v.collection || v }));
    }

    const results = [];
    for (const item of items) {
      const col = item.collection || item.category || item.label;
      const idx = item.index !== undefined ? item.index : item.idx;
      if (col === undefined || idx === undefined) continue;
      const book = batch[idx];
      if (!book) continue;
      results.push({ asin: book.asin, title: book.title, author: book.author, collectionName: col });
    }

    const classified = new Set(results.map(r => r.asin));
    for (const b of batch) { if (!classified.has(b.asin)) log(`AI missed: "${b.title}"`, 'warn'); }
    return results;
  }

  async function classifyBooks(books, config) {
    const bs = config.batchSize || 10;
    const results = [];
    const totalBatches = Math.ceil(books.length / bs);
    for (let i = 0; i < books.length; i += bs) {
      const bn = Math.floor(i / bs) + 1;
      const batch = books.slice(i, i + bs);
      updateProgress(bn, totalBatches, 'AI classifying');
      log(`Batch ${bn}/${totalBatches} (${batch.length} books)...`, 'info');
      let err = null;
      for (let a = 0; a < config.maxRetries; a++) {
        try { const r = await classifyBatch(batch, config); results.push(...parseClassificationResponse(r, batch)); err = null; break; }
        catch (e) { err = e; log(`Attempt ${a + 1} failed: ${e.message}`, 'warn'); if (a < config.maxRetries - 1) await sleep(config.requestDelayMs); }
      }
      if (err) log(`Batch ${bn} failed completely`, 'error');
      if (i + bs < books.length) { log(`Delay ${config.requestDelayMs / 1000}s...`, 'info'); await sleep(config.requestDelayMs); }
    }
    return results;
  }

  // ======================== UI SIMULATION ========================
  function findBookRow(asin) {
    const img = document.getElementById(`content-image-${asin}`);
    return img ? img.closest('[class*="DigitalEntitySummary-module__container"]') : null;
  }

  function isDialogVisible(d) {
    return d && !d.classList.contains('DeviceDialogBox-module_container_hidden__2p01k');
  }

  async function waitFor(fn, timeout = 5000, interval = 200) {
    const start = Date.now();
    while (Date.now() - start < timeout) { const r = fn(); if (r) return r; await sleep(interval); }
    return null;
  }

  /**
   * Apply: simulate clicking through the dialog to add a book to a collection.
   * Steps:
   * 1. Find book row → click "More actions" dropdown
   * 2. In dropdown → click "Add or Remove from Collection"
   * 3. In dialog → find target collection, check its checkbox
   * 4. Click "Make Changes"
   * 5. Wait for dialog to close
   */
  async function applyOneBook(book, attempt = 0) {
    const maxAttempts = 3;
    log(`[${attempt + 1}/${maxAttempts}] "${book.title}" → "${book.collectionName}"`, 'info');

    try {
      const row = findBookRow(book.asin);
      if (!row) throw new Error('Row not found on page');

      // Step 1: Open "More actions"
      const moreBtn = row.querySelector('[id^="MORE_ACTION:"]');
      if (!moreBtn) throw new Error('More Actions button not found');
      const wasExpanded = moreBtn.getAttribute('aria-expanded') === 'true';
      if (!wasExpanded) { moreBtn.click(); await sleep(600); }

      // Step 2: Click "Add or Remove from Collection"
      const actionBtn = document.getElementById(`ADD_OR_REMOVE_FROM_COLLECTION_ACTION_${book.asin}`);
      if (!actionBtn) {
        // Close dropdown before throwing
        if (!wasExpanded) moreBtn.click();
        throw new Error('"Add or Remove from Collection" action not found');
      }
      actionBtn.click();
      await sleep(800);

      // Wait for dialog
      const dialog = await waitFor(
        () => {
          const d = document.querySelector(`[id^="ADD_OR_REMOVE_FROM_COLLECTION_DIALOG_${book.asin}"]`);
          return isDialogVisible(d) ? d : null;
        },
        DEFAULTS.dialogOpenTimeout
      );
      if (!dialog) throw new Error('Dialog did not open');

      // Step 3: Find and check the target collection
      const list = document.getElementById(`AddOrRemoveFromCollection_${book.asin}`);
      if (!list) throw new Error('Collection list not found in dialog');

      let found = false;
      const items = list.querySelectorAll('li');
      for (const item of items) {
        const nameEl = item.querySelector('[class*="action_list_value"]');
        if (!nameEl || nameEl.textContent.trim() !== book.collectionName) continue;
        const cb = item.querySelector('[role="checkbox"]');
        if (!cb) continue;
        if (cb.getAttribute('aria-checked') !== 'true') {
          cb.click();
          await sleep(400);
        }
        found = true;
        break;
      }
      if (!found) throw new Error(`Collection "${book.collectionName}" not in dialog list`);

      // Step 4: Click "Make Changes"
      const confirmBtn = await waitFor(
        () => {
          const b = document.getElementById(`ADD_OR_REMOVE_FROM_COLLECTION_ACTION_${book.asin}_CONFIRM`);
          return b && b.getAttribute('aria-disabled') === 'false' ? b : null;
        },
        5000, 300
      );
      if (!confirmBtn) {
        // Try closing
        const cancel = document.getElementById(`ADD_OR_REMOVE_FROM_COLLECTION_ACTION_${book.asin}_CANCEL`);
        if (cancel) cancel.click();
        throw new Error('"Make Changes" never enabled');
      }
      confirmBtn.click();
      await sleep(500);

      // Step 5: Wait for dialog to close
      const closed = await waitFor(
        () => {
          const d = document.querySelector(`[id^="ADD_OR_REMOVE_FROM_COLLECTION_DIALOG_${book.asin}"]`);
          return !d || !isDialogVisible(d);
        },
        DEFAULTS.dialogCloseTimeout
      );
      if (!closed) log(`Dialog may not have closed`, 'warn');

      // Step 6: Close success notification if it appears
      await sleep(500);
      const successNotification = document.getElementById('notification-success');
      if (successNotification && successNotification.hasAttribute('open')) {
        const closeBtn = document.getElementById('notification-close');
        if (closeBtn) {
          closeBtn.click();
          await sleep(300);
          log(`Closed success notification`, 'info');
        }
      }

      log(`OK: "${book.title}" → "${book.collectionName}"`, 'success');
      return true;
    } catch (err) {
      // Cleanup any lingering dialog
      try {
        const cancelBtn = document.getElementById(`ADD_OR_REMOVE_FROM_COLLECTION_ACTION_${book.asin}_CANCEL`);
        if (cancelBtn) cancelBtn.click();
        const closeBtn = document.querySelector(`[id^="ADD_OR_REMOVE_FROM_COLLECTION_DIALOG_${book.asin}"] [class*="close"]`);
        if (closeBtn) closeBtn.click();
      } catch (e) { /* ignore */ }

      if (attempt < maxAttempts - 1) {
        log(`Retrying: ${err.message}`, 'warn');
        await sleep(2000);
        return applyOneBook(book, attempt + 1);
      }
      log(`FAILED: ${err.message}`, 'error');
      return false;
    }
  }

  async function applyClassifications(classified) {
    let ok = 0, fail = 0;
    for (let i = 0; i < classified.length; i++) {
      updateProgress(i + 1, classified.length, 'Applying');
      (await applyOneBook(classified[i])) ? ok++ : fail++;
      if (i < classified.length - 1) await sleep(1200 + Math.random() * 1500);
    }
    return { ok, fail };
  }

  // ======================== PROCESSING ========================
  function processScanResults(books) {
    state.books = books;
    state.collections = discoverCollections(books);
    state.unclassified = books.filter(b => !b.hasCollection);
    state.classified = [];

    const cCount = books.length - state.unclassified.length;
    log(`Scan done: ${books.length} total, ${cCount} classified, ${state.unclassified.length} UNCLASSIFIED`, 'success');

    if (state.unclassified.length === 0) log('All books already classified!', 'success');
    if (state.collections.length === 0) {
      log('TIP: Open "Add or Remove from Collection" on any book to discover collections.', 'warn');
    } else {
      log(`Collections (${state.collections.length}): ${state.collections.join(', ')}`, 'info');
    }
    renderAll();
  }

  // ======================== UI ========================
  function injectStyles() {
    GM_addStyle(`
#kc-panel{position:fixed;top:10px;right:10px;width:430px;max-height:calc(100vh-20px);background:#fff;border:2px solid #ff9900;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.2);z-index:99999;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;overflow:hidden;}
#kc-panel.minimized #kc-body,#kc-panel.minimized #kc-footer{display:none;}
#kc-header{background:linear-gradient(135deg,#232f3e,#37475a);color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;flex-shrink:0;}
#kc-header h3{margin:0;font-size:14px;font-weight:600;}
#kc-header .kc-btns{display:flex;gap:6px;}
#kc-header .kc-btns button{background:rgba(255,255,255,.2);border:none;color:#fff;cursor:pointer;width:26px;height:26px;border-radius:4px;font-size:14px;line-height:26px;text-align:center;padding:0;}
#kc-body{flex:1;overflow-y:auto;padding:10px 14px;}
#kc-body section{margin-bottom:10px;}
#kc-body h4{margin:0 0 4px;font-size:11px;text-transform:uppercase;color:#555;border-bottom:1px solid #eee;padding-bottom:3px;}
#kc-body label{display:block;font-size:11px;color:#666;margin-top:4px;margin-bottom:1px;}
#kc-body input[type=text],#kc-body input[type=password],#kc-body input[type=number],#kc-body textarea{width:100%;box-sizing:border-box;padding:5px 7px;font-size:12px;border:1px solid #ccc;border-radius:3px;font-family:inherit;}
#kc-body textarea{resize:vertical;min-height:50px;}
.kc-btn{display:inline-block;padding:7px 14px;border:none;border-radius:4px;font-size:12px;cursor:pointer;font-weight:500;}
.kc-btn:disabled{opacity:.5;cursor:not-allowed;}
.kc-btn-primary{background:#ff9900;color:#111;}
.kc-btn-primary:hover:not(:disabled){background:#e8890b;}
.kc-btn-secondary{background:#e7e9ec;color:#111;}
.kc-btn-secondary:hover:not(:disabled){background:#d5d9db;}
.kc-btn-danger{background:#d13212;color:#fff;}
.kc-btn-sm{padding:3px 8px;font-size:11px;}
#kc-footer{border-top:1px solid #eee;padding:8px 14px;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0;}
.kc-progress{background:#f0f0f0;border-radius:3px;height:5px;margin:3px 0;overflow:hidden;}
.kc-progress-bar{height:100%;background:#ff9900;transition:width .3s;}
.kc-log-entry{font-size:10px;padding:1px 0;border-bottom:1px solid #f5f5f5;line-height:1.3;word-break:break-all;}
.kc-log-entry.info{color:#333;}.kc-log-entry.success{color:#067d62;}.kc-log-entry.warn{color:#c45500;}.kc-log-entry.error{color:#d13212;}
.kc-log-time{color:#999;margin-right:4px;}
#kc-logs{max-height:120px;overflow-y:auto;background:#fafafa;padding:2px 4px;border-radius:3px;}
.kc-config-row{display:flex;gap:6px;}.kc-config-row>*{flex:1;}
.kc-book-item{display:flex;align-items:center;gap:4px;padding:2px 0;font-size:11px;}
.kc-book-title{font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.kc-book-author{color:#666;font-size:10px;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.kc-book-result{font-size:11px;color:#067d62;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.kc-collapsible-content{display:none;}.kc-collapsible-content.open{display:block;}
.kc-collapse-toggle{cursor:pointer;color:#0066c0;font-size:11px;}
.kc-stats{display:flex;gap:10px;font-size:11px;}
.kc-stat{background:#f0f0f0;padding:3px 8px;border-radius:10px;}
.kc-stat-val{font-weight:700;color:#ff9900;}
.kc-tags{display:flex;flex-wrap:wrap;gap:3px;margin-top:2px;}
.kc-tag{background:#e8f0fe;color:#1967d2;padding:1px 6px;border-radius:8px;font-size:10px;}
.kc-warn{background:#fef7e0;border:1px solid #f9ab00;border-radius:3px;padding:5px 8px;font-size:11px;margin-top:4px;color:#5f4b00;}
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
    const c = document.getElementById('kc-book-list');
    if (state.unclassified.length === 0) { c.innerHTML = '<span style="color:#999;font-size:12px;">No unclassified books</span>'; return; }
    c.innerHTML = state.unclassified.map(b =>
      `<div class="kc-book-item"><span class="kc-book-title" title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</span><span class="kc-book-author" title="${escapeHtml(b.author)}">${escapeHtml(b.author)}</span></div>`
    ).join('');
  }

  function renderResults() {
    const s = document.getElementById('kc-results-section');
    const c = document.getElementById('kc-results-list');
    if (state.classified.length === 0) { s.style.display = 'none'; return; }
    s.style.display = 'block';
    c.innerHTML = state.classified.map(b => {
      const unknown = !state.collections.includes(b.collectionName);
      return `<div class="kc-book-item"><span class="kc-book-title" title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</span><span>→</span><span class="kc-book-result" style="${unknown?'color:#d13212;text-decoration:line-through':''}">${escapeHtml(b.collectionName)}</span></div>`;
    }).join('');
  }

  function renderCollections() {
    const c = document.getElementById('kc-collections-list');
    if (state.collections.length === 0) { c.innerHTML = '<span style="color:#999;font-size:11px;">None. Open "Add or Remove from Collection" on any book.</span>'; return; }
    c.innerHTML = `<div class="kc-tags">${state.collections.map(n => `<span class="kc-tag">${escapeHtml(n)}</span>`).join('')}</div>`;
  }

  function renderProgress() {
    const ct = document.getElementById('kc-progress-container');
    if (state.progress.total === 0) { ct.style.display = 'none'; return; }
    ct.style.display = 'block';
    const p = Math.round(state.progress.current / state.progress.total * 100);
    document.getElementById('kc-progress-text').textContent = `${state.progress.phase}: ${state.progress.current}/${state.progress.total} (${p}%)`;
    document.getElementById('kc-progress-bar').style.width = p + '%';
  }

  function renderLogs() {
    const c = document.getElementById('kc-logs');
    if (!c) return;
    c.innerHTML = state.logs.slice(-30).map(l => `<div class="kc-log-entry ${l.type}"><span class="kc-log-time">${l.time}</span>${escapeHtml(l.msg)}</div>`).join('');
    c.scrollTop = c.scrollHeight;
  }

  function updateStats() {
    document.getElementById('kc-stat-total').textContent = state.books.length;
    document.getElementById('kc-stat-unclassified').textContent = state.unclassified.length;
    document.getElementById('kc-stat-classified').textContent = state.classified.length;
  }

  function updateButtonStates() {
    document.getElementById('kc-scan').disabled = state.scanning || state.classifying || state.applying;
    document.getElementById('kc-scan-all').disabled = state.scanning || state.classifying || state.applying;
    document.getElementById('kc-classify').disabled = state.scanning || state.classifying || state.applying || state.unclassified.length === 0;
    document.getElementById('kc-apply').disabled = state.scanning || state.classifying || state.applying || state.classified.length === 0;
  }

  // ======================== PANEL CREATION & EVENTS ========================
  function createPanel() {
    const p = document.createElement('div');
    p.id = 'kc-panel';
    p.innerHTML = `
<div id="kc-header"><h3>Kindle Classifier</h3><div class="kc-btns"><button id="kc-minimize">_</button><button id="kc-close">×</button></div></div>
<div id="kc-body">
<section>
  <h4><span class="kc-collapse-toggle" data-target="kc-config-content">Configuration ▾</span></h4>
  <div id="kc-config-content" class="kc-collapsible-content">
    <label>API Endpoint</label><input id="kc-api-endpoint" placeholder="https://api.openai.com/v1/chat/completions">
    <label>API Key</label><div class="kc-config-row"><input type="password" id="kc-api-key" placeholder="sk-..."><button class="kc-btn kc-btn-secondary kc-btn-sm" id="kc-save-config" style="flex:0;">Save</button></div>
    <label>Model</label><input id="kc-model" placeholder="gpt-4o-mini">
    <label>Batch Size</label><input type="number" id="kc-batch-size" min="1" max="50" value="10">
    <label>Delay (ms)</label><input type="number" id="kc-delay" min="500" max="30000" value="3000">
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
  <button class="kc-btn kc-btn-secondary" id="kc-scan-all">Scan All</button>
  <button class="kc-btn kc-btn-primary" id="kc-classify" disabled>Classify</button>
  <button class="kc-btn kc-btn-danger" id="kc-apply" disabled>Apply</button>
</div>`;
    document.body.appendChild(p);
  }

  function setupEvents(config) {
    document.getElementById('kc-minimize').onclick = () => document.getElementById('kc-panel').classList.toggle('minimized');
    document.getElementById('kc-close').onclick = () => {
      document.getElementById('kc-panel').style.display = 'none';
      if (!document.getElementById('kc-reopen')) {
        const r = document.createElement('div');
        r.id = 'kc-reopen';
        r.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:#ff9900;color:#111;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;';
        r.textContent = 'KC'; r.onclick = () => { document.getElementById('kc-panel').style.display = 'flex'; r.remove(); };
        document.body.appendChild(r);
      }
    };
    document.querySelectorAll('.kc-collapse-toggle').forEach(t => {
      t.onclick = () => {
        const target = document.getElementById(t.dataset.target);
        target.classList.toggle('open');
        t.textContent = t.textContent.replace(target.classList.contains('open') ? '▸' : '▾', target.classList.contains('open') ? '▾' : '▸');
      };
    });
    document.getElementById('kc-save-config').onclick = () => { saveConfigFromUI(); log('Saved', 'success'); };

    // Refresh collections from dialog
    document.getElementById('kc-refresh-collections').onclick = () => {
      const names = discoverFromDialog();
      if (names.length > state.collections.length) {
        state.collections = names;
        renderCollections();
        log(`Found ${names.length} collections from dialog`, 'success');
      } else if (names.length > 0) {
        state.collections = names;
        renderCollections();
        log(`Refreshed: ${names.length} collections`, 'info');
      } else {
        log('No dialog found. Open "Add or Remove from Collection" on a book first.', 'warn');
      }
    };

    // Scan
    document.getElementById('kc-scan').onclick = async () => {
      if (state.scanning) return;
      state.scanning = true; updateButtonStates();
      try { processScanResults(await scanCurrentPage()); } catch (e) { log(`Scan: ${e.message}`, 'error'); }
      state.scanning = false; updateButtonStates();
    };
    document.getElementById('kc-scan-all').onclick = async () => {
      if (state.scanning) return;

      // CRITICAL: Clear any existing scan state before starting new scan
      const oldState = GM_getValue('kc_scan_state', null);
      if (oldState) {
        GM_setValue('kc_scan_state', null);
      }

      state.scanning = true; updateButtonStates();
      try {
        const books = await scanAllPages();
        // Only process if we didn't navigate away
        if (books.length > 0) {
          processScanResults(books);
        }
      } catch (e) {
        log(`Scan: ${e.message}`, 'error');
        GM_setValue('kc_scan_state', null);
      }
      state.scanning = false; updateProgress(0, 0, ''); updateButtonStates();
    };

    // Classify
    document.getElementById('kc-classify').onclick = async () => {
      if (state.classifying) return;
      const cfg = readConfigFromUI();
      if (!cfg.apiKey || cfg.apiKey.length < 10) { log('Set a valid API key', 'error'); return; }
      if (state.collections.length === 0) { log('No collections. Open dialog + Refresh first.', 'error'); return; }
      state.classifying = true; updateButtonStates();
      try {
        log(`Classifying ${state.unclassified.length} books...`, 'info');
        state.classified = await classifyBooks(state.unclassified, cfg);
        log(`Done: ${state.classified.length} classifications`, 'success');
        renderAll();
      } catch (e) { log(`Classify: ${e.message}`, 'error'); }
      state.classifying = false; updateButtonStates();
    };

    // Apply
    document.getElementById('kc-apply').onclick = async () => {
      if (state.applying) return;
      if (state.classified.length === 0) { log('Nothing to apply', 'warn'); return; }
      const valid = state.classified.filter(r => state.collections.includes(r.collectionName));
      if (valid.length === 0) { log('All results have unknown collections. Cannot apply.', 'error'); return; }
      if (valid.length < state.classified.length) {
        if (!confirm(`${state.classified.length - valid.length} books skipped. Apply ${valid.length}?`)) return;
      }
      state.applying = true; updateButtonStates();
      try {
        log(`Applying ${valid.length} books — keep tab visible!`, 'warn');
        const { ok, fail } = await applyClassifications(valid);
        log(`Applied: ${ok} ok, ${fail} failed`, ok > 0 ? 'success' : 'error');

        // Auto-refresh after successful application
        if (ok > 0) {
          log('Refreshing page to update book list...', 'info');
          await sleep(2000);
          window.location.reload();
        } else {
          state.unclassified = state.unclassified.filter(b => !valid.some(v => v.asin === b.asin));
          state.classified = []; renderAll();
        }
      } catch (e) { log(`Apply: ${e.message}`, 'error'); }
      state.applying = false; updateProgress(0, 0, ''); updateButtonStates();
    };

    // Draggable
    makeDraggable(document.getElementById('kc-panel'), document.getElementById('kc-header'));
  }

  function makeDraggable(panel, header) {
    let ox = 0, oy = 0;
    header.onmousedown = e => {
      if (e.target.tagName === 'BUTTON') return;
      const r = panel.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top;
      const mm = ev => { panel.style.left = (ev.clientX - ox) + 'px'; panel.style.top = (ev.clientY - oy) + 'px'; panel.style.right = 'auto'; };
      const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
      document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
      e.preventDefault();
    };
  }

  // ======================== CONFIG HELPERS ========================
  function readConfigFromUI() {
    return {
      apiEndpoint: document.getElementById('kc-api-endpoint').value.trim(),
      apiKey: document.getElementById('kc-api-key').value.trim(),
      model: document.getElementById('kc-model').value.trim(),
      batchSize: parseInt(document.getElementById('kc-batch-size').value) || 10,
      requestDelayMs: parseInt(document.getElementById('kc-delay').value) || 3000,
      systemPrompt: document.getElementById('kc-system-prompt').value.trim(),
      maxRetries: DEFAULTS.maxRetries,
    };
  }
  function saveConfigFromUI() { saveConfig(readConfigFromUI()); }
  function loadConfigToUI(cfg) {
    document.getElementById('kc-api-endpoint').value = cfg.apiEndpoint || DEFAULTS.apiEndpoint;
    document.getElementById('kc-api-key').value = cfg.apiKey || '';
    document.getElementById('kc-model').value = cfg.model || DEFAULTS.model;
    document.getElementById('kc-batch-size').value = cfg.batchSize || DEFAULTS.batchSize;
    document.getElementById('kc-delay').value = cfg.requestDelayMs || DEFAULTS.requestDelayMs;
    document.getElementById('kc-system-prompt').value = cfg.systemPrompt || DEFAULTS.systemPrompt;
  }

  // ======================== INIT ========================
  function init() {
    const cfg = loadConfig();
    injectStyles();
    createPanel();
    loadConfigToUI(cfg);
    setupEvents(cfg);
    renderCollections();

    // Check if we're in the middle of a multi-page scan
    const scanState = GM_getValue('kc_scan_state', null);
    if (scanState) {
      try {
        const state = JSON.parse(scanState);
        const currentPage = parseInt(new URLSearchParams(window.location.search).get('pageNumber')) || 1;


        // Check if scan is recent (within 2 minutes)
        if (Date.now() - state.timestamp < 120000 && state.scanning) {
          log(`Resuming multi-page scan (page ${currentPage}/${state.totalPages})...`, 'info');

          // CRITICAL: Wait for books to load before scanning
          waitFor(() => {
            const containers = document.querySelectorAll('[class*="DigitalEntitySummary-module__container"]');
            return containers.length > 0 ? true : null;
          }, 10000, 500).then(() => {
            // Merge current page books
            const currentBooks = parseBooksFromDocument(document);
            const seenAsins = new Set(state.seenAsins);
            let newCount = 0;
            currentBooks.forEach(b => {
              if (!seenAsins.has(b.asin)) {
                seenAsins.add(b.asin);
                state.allBooks.push(b);
                newCount++;
              }
            });

            const unclassified = currentBooks.filter(b => !b.hasCollection).length;
            log(`Page ${currentPage}: ${currentBooks.length} books (${newCount} new, total: ${state.allBooks.length})`, 'info');

            // Check if we need to continue
            if (currentPage < state.totalPages) {
              // Continue to next page
              const nextPage = currentPage + 1;
              GM_setValue('kc_scan_state', JSON.stringify({
                ...state,
                currentPage,
                allBooks: state.allBooks,
                seenAsins: [...seenAsins],
                timestamp: Date.now()
              }));

              log(`Navigating to page ${nextPage}/${state.totalPages}...`, 'info');
              setTimeout(() => {
                const url = new URL(window.location.href);
                url.searchParams.set('pageNumber', nextPage);
                window.location.href = url.toString();
              }, DEFAULTS.pageDelayMs);
            } else {
              // Scan complete - navigate back to page 1
              const totalUncls = state.allBooks.filter(b => !b.hasCollection).length;
              log(`All pages scanned! Total: ${state.allBooks.length} books`, 'success');

              if (currentPage !== 1) {
                log(`Returning to page 1...`, 'info');
                GM_setValue('kc_scan_state', JSON.stringify({
                  ...state,
                  allBooks: state.allBooks,
                  seenAsins: [...seenAsins],
                  scanning: false,
                  returning: true,
                  timestamp: Date.now()
                }));

                setTimeout(() => {
                  const url = new URL(window.location.href);
                  url.searchParams.set('pageNumber', '1');
                  window.location.href = url.toString();
                }, 1000);
              } else {
                // Already on page 1, show results
                GM_setValue('kc_scan_state', null);
                processScanResults(state.allBooks);
              }
            }
          });
          return; // Don't continue init
        } else if (state.returning) {
          // Just returned to page 1 after scan
          log(`Scan complete: ${state.allBooks.length} total books`, 'success');
          GM_setValue('kc_scan_state', null);
          processScanResults(state.allBooks);
          return;
        } else {
          GM_setValue('kc_scan_state', null);
        }
      } catch (e) {
        log(`Error resuming scan: ${e.message}`, 'error');
        GM_setValue('kc_scan_state', null);
      }
    }

    // Normal init - auto-scan current page only
    setTimeout(() => {
      const books = parseBooksFromDocument(document);
      if (books.length > 0) {
        const uncls = books.filter(b => !b.hasCollection).length;
        log(`Auto-scanned current page: ${books.length} books`, 'info');
        processScanResults(books);
      }
    }, 1500);

    log('Kindle Classifier v2.6.0 — Multi-page navigation mode', 'info');
    log('Click "Scan All" to scan all pages (will navigate through pages automatically)', 'info');

    const ds = debounce(() => saveConfigFromUI(), 2000);
    ['kc-api-endpoint', 'kc-api-key', 'kc-model', 'kc-batch-size', 'kc-delay', 'kc-system-prompt']
      .forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', ds); });
  }
  function debounce(fn, d) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), d); }; }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
