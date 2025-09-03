Kyle, this dashboard is already snappy and legible, but there are a few correctness bugs, some UX papercuts, and several performance/accessibility wins we can grab fast. I’ll give Claude precise, drop-in patches first (so you can paste and go), then a short checklist for broader hardening and dev-friendliness.&#x20;

---

# Critical fixes (drop-in patches)

## 1) Define `logApiCall`, fix clipboard var, and unify console plumbing

You call `logApiCall` in multiple places, but only `logBatchOperation` exists. Also, `copyConsoleToClipboard` references `apiConsoleEntries` (undefined). Patch below consolidates everything on `batchConsoleEntries`, adds `logApiCall`, and fixes the clipboard function.

```diff
--- a/dashboard.html
+++ b/dashboard.html
@@ -1,7 +1,7 @@
 <script>
-        // Batch Console logging
-        const batchConsoleEntries = [];
-        let currentFilter = 'all';
+        // Console/telemetry
+        const batchConsoleEntries = [];   // bounded in memory & DOM
+        let currentFilter = 'all';
+        const MAX_IN_MEMORY = 200, MAX_IN_DOM = 100;

         function logBatchOperation(type, batchId, message, data = {}) {
             const timestamp = new Date().toLocaleTimeString();
@@
             if (batchConsoleEntries.length > 100) {
                 batchConsoleEntries.shift();
             }
         }
+
+        // Unified logger used by API/UI handlers
+        function logApiCall(kind, method, url, data = {}) {
+            const entry = {
+                id: Date.now(),
+                timestamp: new Date().toLocaleTimeString(),
+                type: kind,          // 'request' | 'response' | 'error' | 'warning' | 'validation'
+                method: method || '',
+                url: url || '',
+                data
+            };
+            batchConsoleEntries.push(entry);
+            if (batchConsoleEntries.length > MAX_IN_MEMORY) batchConsoleEntries.shift();
+            if (shouldShowEntry(entry)) addConsoleEntry(entry);
+        }
@@
-            while (consoleOutput.children.length > 50) {
+            while (consoleOutput.children.length > MAX_IN_DOM) {
                 consoleOutput.removeChild(consoleOutput.lastChild);
             }
         }
@@
-        function copyConsoleToClipboard() {
-            const consoleText = apiConsoleEntries.map(entry => {
+        function copyConsoleToClipboard() {
+            const consoleText = batchConsoleEntries
+              .filter(shouldShowEntry)
+              .map(entry => {
                 let text = `[${entry.timestamp}] ${entry.type.toUpperCase()}: ${entry.method} ${entry.url}`;
                 if (entry.data) {
                     if (entry.data.status) text += ` - Status: ${entry.data.status}`;
                     if (entry.data.confidence) text += ` - Confidence: ${(entry.data.confidence * 100).toFixed(1)}%`;
                     if (entry.data.message) text += ` - ${entry.data.message}`;
                     if (entry.data.result) text += `\nResult: ${JSON.stringify(entry.data.result, null, 2)}`;
                 }
                 return text;
             }).join('\n\n');
```

## 2) Add the missing DOM you reference (progress + upload preview + overlay)

Several IDs used in JS don’t exist in the HTML (`progressFill`, `progressPercent`, `uploadArea`, `imagePreview`, `previewImage`, `imageInfo`, `imageFileName`, `imageSize`, `imageDimensions`, `processingOverlay`). Add this block inside the **left column** (capture section), under the “Batch Summary Cards”.

```diff
--- a/dashboard.html
+++ b/dashboard.html
@@ -200,6 +200,92 @@
                 </div>
 
+                <!-- Upload / Capture UI -->
+                <div id="uploadWrapper" aria-labelledby="uploadHeading">
+                  <h3 id="uploadHeading" style="color:#1F2937;margin:16px 0 8px;">Add Cards</h3>
+                  <div style="display:flex;gap:10px;margin-bottom:12px;">
+                    <button class="btn btn-secondary" onclick="document.getElementById('fileInput').click()">Select Image</button>
+                    <button class="btn btn-primary" onclick="captureCard()">Capture From Camera</button>
+                  </div>
+                  <input id="fileInput" type="file" accept="image/*" aria-label="Select card image" onchange="handleFileSelect(event)" />
+
+                  <!-- Drag & Drop area -->
+                  <div id="uploadArea" class="upload-area" role="button" tabindex="0" aria-label="Drop an image here or press to select">
+                    <div class="upload-icon">⬆</div>
+                    <div class="upload-text">Drop an image here</div>
+                    <div class="upload-hint">PNG, JPG up to ~20MB</div>
+                  </div>
+
+                  <!-- Image preview -->
+                  <div id="imagePreview" style="display:none;margin-top:10px;">
+                    <img id="previewImage" alt="Selected card preview" style="max-width:100%;border-radius:8px;border:1px solid #E5E7EB;" />
+                  </div>
+
+                  <!-- Selected image info -->
+                  <div id="imageInfo" style="display:none;margin-top:8px;font-size:0.9em;color:#374151;">
+                    <span id="imageFileName"></span> —
+                    <span id="imageSize"></span> —
+                    <span id="imageDimensions"></span>
+                    <button class="btn btn-secondary" style="margin-left:10px;flex:0;" onclick="clearImagePreview(event)">Clear</button>
+                  </div>
+                </div>
+
+                <!-- Processing overlay for preview -->
+                <div id="processingOverlay" aria-hidden="true" style="display:none;position:absolute;inset:0;background:rgba(0,0,0,0.35);backdrop-filter:saturate(120%) blur(2px);align-items:center;justify-content:center;border-radius:12px;">
+                  <div class="spinner" aria-label="Processing"></div>
+                </div>
+
+                <!-- Global progress -->
+                <div class="progress-container" aria-labelledby="progressLabel">
+                  <div id="progressLabel" class="progress-label">
+                    <span>Processing Progress</span>
+                    <span id="progressPercent">0%</span>
+                  </div>
+                  <div class="progress-bar" aria-valuemin="0" aria-valuemax="100" aria-live="polite">
+                    <div id="progressFill" class="progress-fill" style="width:0%"></div>
+                  </div>
+                </div>
```

## 3) Don’t leak untrusted HTML; swap to safe text setters

`showValidationStatus` uses `innerHTML` with dynamic content. For anything user/API-influenced, prefer `textContent` or controlled element nodes.

```diff
--- a/dashboard.html
+++ b/dashboard.html
@@ -740,16 +740,22 @@
-            tcgApiElement.innerHTML = '<span class="status-dot pending"></span> Validating...';
+            tcgApiElement.replaceChildren();
+            const pDot = document.createElement('span');
+            pDot.className = 'status-dot pending';
+            const pText = document.createTextNode(' Validating...');
+            tcgApiElement.append(pDot, pText);
@@
-                    tcgApiElement.innerHTML = '<span class="status-dot success"></span> Validated';
-                    marketPriceElement.textContent = result.market_price ? `$${result.market_price}` : 'N/A';
-                    officialImageElement.innerHTML = '<span class="status-dot success"></span> Available';
+                    tcgApiElement.replaceChildren(Object.assign(document.createElement('span'),{className:'status-dot success'}), document.createTextNode(' Validated'));
+                    marketPriceElement.textContent = (typeof result.market_price === 'number') ? `$${result.market_price}` : 'N/A';
+                    officialImageElement.replaceChildren(Object.assign(document.createElement('span'),{className:'status-dot success'}), document.createTextNode(' Available'));
                     validationMethodElement.textContent = result.validation_method || 'ML + API';
                 } else {
-                    tcgApiElement.innerHTML = '<span class="status-dot error"></span> Not Available';
+                    tcgApiElement.replaceChildren(Object.assign(document.createElement('span'),{className:'status-dot error'}), document.createTextNode(' Not Available'));
                     marketPriceElement.textContent = 'N/A';
-                    officialImageElement.innerHTML = '<span class="status-dot error"></span> Not Available';
+                    officialImageElement.replaceChildren(Object.assign(document.createElement('span'),{className:'status-dot error'}), document.createTextNode(' Not Available'));
                     validationMethodElement.textContent = 'ML Only';
                 }
```

## 4) Respect “reduce motion” and avoid GPU-heavy visuals in kiosk mode

Particles, shimmer, and rotating UI cost GPU/CPU and can stutter capture PCs. Gate them with `prefers-reduced-motion` and a `data-mode="kiosk"` flag.

```diff
--- a/dashboard.html
+++ b/dashboard.html
@@ -35,6 +35,25 @@
         @keyframes float {
             from {
                 transform: translateY(100vh) rotate(0deg);
                 opacity: 0;
             }
@@
         @keyframes shimmer {
             0% { transform: translateX(-100%); }
             100% { transform: translateX(100%); }
         }
+
+        /* Respect reduced motion / kiosk mode */
+        @media (prefers-reduced-motion: reduce) {
+          .particle, .pokeball, .progress-fill::after { animation: none !important; }
+        }
+        body[data-mode="kiosk"] .particles { display: none !important; }
+        body[data-mode="kiosk"] .pokeball { animation: none !important; }
+        body[data-mode="kiosk"] .progress-fill::after { animation: none !important; }
```

And gate particle creation:

```diff
-        function createParticles() {
+        function createParticles() {
+            if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
+            if (document.body.dataset.mode === 'kiosk') return;
             const particlesContainer = document.getElementById('particles');
             for (let i = 0; i < 50; i++) {
```

## 5) Config via `<meta>` (no source edits per environment)

Don’t hardcode `WS_URL`/`API_URL`. Read from meta with safe fallbacks:

```diff
-        let ws = null;
-        const WS_URL = 'ws://localhost:3001';
-        const API_URL = 'http://localhost:8000';
+        let ws = null;
+        const WS_URL = document.querySelector('meta[name="ws-url"]')?.content || 'ws://localhost:3001';
+        const API_URL = document.querySelector('meta[name="api-url"]')?.content || 'http://localhost:8000';
```

Add to `<head>`:

```html
<meta name="api-url" content="http://localhost:8000">
<meta name="ws-url"  content="ws://localhost:3001">
```

## 6) Unify API usage and add backoff for optional WS

`captureCard` hits `/api/capture` relative path while others use `API_URL`. Align and add a quiet reconnect backoff for WS without spamming logs.

```diff
-        async function captureCard() {
+        async function captureCard() {
             updateStatus('Capturing...', true);
             try {
-                const response = await fetch('/api/capture', { method: 'POST' });
+                const response = await fetch(`${API_URL}/api/capture`, { method: 'POST' });
@@
-        function connectWebSocket() {
+        function connectWebSocket(retries = 0) {
             try {
                 ws = new WebSocket(WS_URL);
                 ws.onopen = () => {
                     updateStatus('Connected', true);
                     console.log('WebSocket connected');
                 };
                 ws.onmessage = (event) => {
                     const data = JSON.parse(event.data);
                     handleWebSocketMessage(data);
                 };
                 ws.onerror = (error) => {
-                    // Silently handle WebSocket errors - it's optional
-                    console.log('WebSocket not available (optional feature)');
-                    updateStatus('API Ready', true); // Still show as ready
+                    // optional; fall back to REST
+                    updateStatus('API Ready', true);
                 };
                 ws.onclose = () => {
-                    // Don't show as disconnected if WebSocket is optional
-                    console.log('WebSocket closed (optional feature)');
-                    // Don't attempt reconnect if it's not available
+                    // exponential backoff up to ~30s
+                    const next = Math.min(30000, 500 * Math.pow(2, retries));
+                    setTimeout(() => connectWebSocket(retries + 1), next);
                 };
             } catch (error) {
-                console.log('WebSocket not available - using REST API only');
+                // optional; REST only
                 updateStatus('API Ready', true);
             }
         }
```

---

# UX / usability upgrades (tight checklist)

* **Remove emoji in labels** for professional environments (“Batch Results”, “Model Performance”, “Batch Console”) and use icons only where helpful. Keep color + clear copy for confidence states.
* **Keyboard & screen-reader support:**

  * Add `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls` on tab buttons; `role="tabpanel"` on tab panels.
  * Add visible focus styles (`:focus-visible`) to buttons/links.
  * Mark the status text as `aria-live="polite"` so screen readers announce progress.
* **High-contrast mode:** Provide a CSS class (e.g., `body.theme-contrast`) that lifts text contrast and reduces gradients.
* **Empty states and errors:** When no batches/data yet, show a helpful empty state card with “how to start” tips. On fetch failures, render inline retry buttons.
* **Bounded console & virtualization:** You already cap to 50 DOM nodes; also debounce renders if log volume spikes, and provide a “Pause console” toggle for debugging.
* **Batch filters:** The top select (“Today/Yesterday/Week/Month”) should drive an actual query. Until wired, render a non-blocking toast: “Filters are UI-only in this build.”
* **Price/validation row actions:** Add contextual actions beside each card result: “Open in TCG API”, “Copy name/number”, “Flag for review”, “Open inventory record”.
* **Persistent user prefs:** Store last used tab, filters, and “reduced motion” toggle in `localStorage`.

---

# Dev-friendliness & maintainability

* **Split JS into modules** (`dashboard.config.js`, `dashboard.console.js`, `dashboard.upload.js`, `dashboard.ws.js`). Keep pure functions testable.
* **Type annotations:** Convert to TypeScript or add JSDoc types for `Result`, `ConsoleEntry`, `ResourceStatus`.
* **ESLint/Prettier:** Enforce consistent DOM access and safe text updates; forbid direct `innerHTML` except in whitelisted components.
* **Feature flags:** Read `data-mode="kiosk|dev"` from `<body>` for toggling particles, logging verbosity, and console volume.
* **CSP headers (when served):** Use a minimal CSP (no inline scripts) or add `nonce` if inline is required. Move large style blocks to a `.css` file.

---

# Performance notes (aligned to CardMint’s latency budget)

* **Trim heavy visuals:** Gradients, big shadows, and animated particles can cost frames; we now gate or disable them in kiosk/reduced-motion.
* **Shimmer → prefer transform-based:** Your shimmer is already transform-animated; ensure it’s not painting large areas while processing; or disable during recognition (`document.body.dataset.busy = '1'`).
* **Avoid layout thrash:** Batch DOM writes (e.g., using `DocumentFragment`) when adding multiple console entries.
* **Use `requestIdleCallback`** for non-critical updates (e.g., updating “batch trends” counters).
* **Defer non-critical fetches** until first interaction (models/status ping can wait 1–2s after load).

---

# Small polish patches

### A) Tabs: ARIA and active states

```diff
- <div class="tab-navigation">
-   <button class="tab-button active" onclick="switchTab('results')" id="resultsTab">
+ <div class="tab-navigation" role="tablist" aria-label="Dashboard sections">
+   <button class="tab-button active" role="tab" aria-selected="true" aria-controls="resultsTabContent" onclick="switchTab('results')" id="resultsTab">
      Model Performance
    </button>
-   <button class="tab-button" onclick="switchTab('console')" id="consoleTab">
+   <button class="tab-button" role="tab" aria-selected="false" aria-controls="consoleTabContent" onclick="switchTab('console')" id="consoleTab">
      Batch Console
    </button>
  </div>
@@
- function switchTab(tabName) {
+ function switchTab(tabName) {
     document.querySelectorAll('.tab-button').forEach(btn => {
-        btn.classList.remove('active');
+        const isActive = btn.id === tabName + 'Tab';
+        btn.classList.toggle('active', isActive);
+        btn.setAttribute('aria-selected', String(isActive));
     });
     document.querySelectorAll('.tab-content').forEach(content => {
-        content.classList.remove('active');
+        content.classList.toggle('active', content.id === tabName + 'TabContent');
+        content.setAttribute('role','tabpanel');
     });
 }
```

### B) Status text is live-region

```diff
- <div class="status-text" id="statusText">Batch System Ready</div>
+ <div class="status-text" id="statusText" aria-live="polite">Batch System Ready</div>
```

---

# Where this helps CardMint’s goals

* **Reliability under load:** Motion gating and console bounding prevent UI hiccups during high-throughput scanning, keeping the 400 ms capture loop unaffected.
* **Operator clarity:** Safer rendering, stronger status semantics, and clear error/empty states reduce confusion at the kiosk.
* **Faster iteration:** Config via meta, unified logging, and modular JS make environment switches and debugging straightforward (and Claude-friendly).
* **Security hygiene:** Eliminating untrusted `innerHTML` and adding CSP/read-only config is table-stakes for the public repo push.

If you want, I can spit out a “post-patch” file for quick replacement, or a Vite-ready split (HTML + TS modules) so Claude can wire it into the dashboard quickly.

