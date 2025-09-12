// CardMint Operator UI — skeleton
// Offline-first; connects only to http://localhost:3000

const apiBase = 'http://localhost:3000';

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const canvas = $('#canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const dz = $('#dropzone') as HTMLElement;
const input = $('#file-input') as HTMLInputElement;
const btnScan = $('#btn-scan') as HTMLButtonElement;
const btnAccept = $('#btn-accept') as HTMLButtonElement;
const btnAcceptTop3 = $('#btn-accept-top3') as HTMLButtonElement;
const btnRecap = $('#btn-recap') as HTMLButtonElement;
const btnTestAll = $('#btn-test-all') as HTMLButtonElement;
const badgeApi = $('#badge-api') as HTMLElement;

let lastFile: File | undefined;
let lastScanId: string | undefined;
let currentScanData: any = null;
let sessionMetrics = {
  cardsProcessed: 0,
  improvementsMade: 0,
  totalConfidenceBoost: 0,
  totalProcessingTime: 0,
  improvements: [] as any[]
};

// ROI editor and concurrency state
let roiVersion: Record<string, number> = { name: 0, hp: 0, set_number: 0 };
let lastRid: Record<string, number> = { name: 0, hp: 0, set_number: 0 };
let batchAbort: AbortController | null = null;
const MAX_CONCURRENT = 2;

function toast(msg: string, cls = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + cls;
  t.textContent = msg;
  $('#toasts')!.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

async function ping() {
  try {
    const r = await fetch(apiBase + '/api/health');
    if (!r.ok) throw new Error(String(r.status));
    
    const healthData = await r.json();
    
    // Enhanced footer telemetry as per 12sep-imp-tracker.md
    const telemetryParts = [
      `backend=${healthData.backend_id || 'unknown'}`,
      `precision=${healthData.precision || 'fp32'}`,
      `offline=${healthData.offline || 1}`,
      `threads=${healthData.threads?.OMP || 4}`,
      `hw=${(healthData.cpu_model || 'unknown').split(' ')[0]}(${healthData.cpu_cores || '?'}c)`
    ];
    
    badgeApi.textContent = telemetryParts.join('  •  ');
    (badgeApi as any).style = 'color:#2ea043';
  } catch {
    badgeApi.textContent = 'API: Unavailable';
    (badgeApi as any).style = 'color:#f85149';
  }
}

function wireDropzone() {
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('dragover', (e) => {
    e.preventDefault(); dz.classList.add('hover');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('hover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('hover');
    const f = e.dataTransfer?.files?.[0]; if (f) onFile(f);
  });
  input.addEventListener('change', () => {
    const f = input.files?.[0]; if (f) onFile(f);
  });
}

function onFile(f: File) {
  lastFile = f; btnScan.disabled = false; btnAccept.disabled = true; btnRecap.disabled = true; btnTestAll.disabled = true; btnAcceptTop3.hidden = true;
  const img = new Image(); img.onload = () => {
    const maxW = 1000; const scale = Math.min(1, maxW / img.width);
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }; img.src = URL.createObjectURL(f);
}

async function scanFile() {
  if (!lastFile) return;
  const fd = new FormData(); fd.append('image', lastFile); fd.append('viz', '1');
  toast('Scanning…'); btnScan.disabled = true;
  try {
    // TODO: Claude — implement /api/scan to return PRD JSON
    const r = await fetch(apiBase + '/api/scan', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('scan_failed ' + r.status);
    const data = await r.json();
    lastScanId = data.scan_id;
    renderScan(data);
    toast('Scan complete', 'ok');
    btnAccept.disabled = false; btnRecap.disabled = false; btnTestAll.disabled = false;
  } catch (e) {
    console.error(e);
    toast('Scan failed', 'bad');
    btnScan.disabled = false;
  }
}

function drawRois(rois: Array<{ field: string; box: [number, number, number, number]; aux?: any; metrics?: any }>) {
  const w = canvas.width, h = canvas.height;
  ctx.lineWidth = 2;
  
  rois?.forEach((r) => {
    const [x1, y1, x2, y2] = r.box;
    const boxWidth = x2 - x1;
    const boxHeight = y2 - y1;
    
    // Color code based on coverage and edge clarity
    let strokeColor = '#388bfd'; // Default blue
    const mx = (r as any).metrics || (r as any).aux;
    if (mx) {
      const coverage = mx.coverage?.coverage_pct || 0;
      const clarity = mx.edge_clarity_score || 0;
      const minCheck = mx.min_crop_check?.meets_min_size;
      
      // Red for poor metrics, yellow for borderline, green for good
      if (!minCheck || coverage < 3 || clarity < 30) {
        strokeColor = '#ff4444'; // Red for problems
      } else if (coverage < 5 || clarity < 50) {
        strokeColor = '#ffaa44'; // Orange for borderline
      } else if (coverage >= 7 && clarity >= 60) {
        strokeColor = '#44ff44'; // Green for good
      }
    }
    
    ctx.strokeStyle = strokeColor;
    ctx.strokeRect(x1, y1, boxWidth, boxHeight);
    
    // Draw field label with metrics
    ctx.fillStyle = strokeColor;
    ctx.font = '12px monospace';
    const label = r.field.toUpperCase();
    const metrics = mx ? ` (${Math.round(mx.coverage?.coverage_pct || 0)}%, ${Math.round(mx.edge_clarity_score || 0)})` : '';
    ctx.fillText(label + metrics, x1, y1 - 5);
  });
}

function renderScan(s: any) {
  // Store scan data for ROI testing and dev payload copying
  currentScanData = s;
  
  // Draw image again from returned image_url (data URL or file URL)
  if (s.image_url) {
    const img = new Image();
    img.onload = () => { 
      canvas.width = img.width; 
      canvas.height = img.height; 
      ctx.drawImage(img, 0, 0); 
      drawRois(s.rois || []); 
    };
    img.src = s.image_url;
  } else {
    drawRois(s.rois || []);
  }
  
  // Display crops
  (document.getElementById('crop-name') as HTMLImageElement).src = s.crops?.name || '';
  (document.getElementById('crop-hp') as HTMLImageElement).src = s.crops?.hp || '';
  (document.getElementById('crop-set') as HTMLImageElement).src = s.crops?.set_number || '';
  
  // Display field values and confidence
  (document.getElementById('out-name') as HTMLOutputElement).value = s.fields?.name?.value ?? '—';
  (document.getElementById('out-hp') as HTMLOutputElement).value = s.fields?.hp?.value ?? '—';
  (document.getElementById('out-set') as HTMLOutputElement).value = s.fields?.set_number?.value ?? '—';
  
  $('#conf-name').textContent = s.conf?.name ? `(${Math.round(s.conf.name * 100)}%)` : '';
  $('#conf-hp').textContent = s.conf?.hp ? `(${Math.round(s.conf.hp * 100)}%)` : '';
  $('#conf-set').textContent = s.conf?.set_number ? `(${Math.round(s.conf.set_number * 100)}%)` : '';
  
  // Display decision
  const d = s.decision?.kind || '—';
  const el = $('#decision'); 
  el.textContent = `Decision: ${d}${s.decision?.reason ? ' — ' + s.decision.reason : ''}`;
  el.className = 'decision ' + (d === 'auto_accept' ? 'ok' : d === 'ask_user_top3' ? 'warn' : d === 'recapture' ? 'bad' : '');
  
  // Display operator-friendly emissions
  displayOperatorEmissions(s.emissions || []);
  
  // Display timings and SLO badges
  displayTimings(s.timings_ms || {});
  
  // Update session metrics
  updateSessionMetrics(s);
  
  // Display ROI status indicators
  displayROIStatus(s.rois || []);
  
  // Handle top-3 selection if needed
  if (d === 'ask_user_top3' && s.top3) {
    showTop3Selection(s.top3);
  } else {
    btnAcceptTop3.hidden = true;
  }
  
  // Display ROI metrics and HITL telemetry
  displayROIMetrics(s.rois || []);
  displayNormalizationTelemetry(s.dev?.normalization_events || []);

  // Overlay download link
  const overlayLink = document.getElementById('overlay-link') as HTMLAnchorElement;
  if (overlayLink) {
    if (s.overlay_url) {
      overlayLink.href = s.overlay_url;
      overlayLink.style.display = 'inline';
      overlayLink.textContent = 'Download ROI Overlay';
    } else {
      overlayLink.style.display = 'none';
    }
  }
  
  // Show HITL feedback panel if we have telemetry data
  const hitlPanel = $('#hitl-feedback') as HTMLElement;
  if ((s.dev?.normalization_events && s.dev.normalization_events.length > 0) || 
      (s.rois && s.rois.some((r: any) => r.metrics || r.aux))) {
    hitlPanel.style.display = 'block';
  }
}

function displayEmissions(emissions: any[]) {
  // Add emissions feed to header or create emissions section
  const badgesEl = $('#badges');
  
  // Clear previous emissions
  const existingEmissions = badgesEl.querySelectorAll('.emission');
  existingEmissions.forEach(el => el.remove());
  
  // Add new emissions
  emissions.forEach(emission => {
    const emissionEl = document.createElement('span');
    emissionEl.className = `badge emission ${emission.level}`;
    emissionEl.textContent = `${emission.code}: ${emission.message}`;
    emissionEl.title = `Next: ${emission.next_action}`;
    badgesEl.appendChild(emissionEl);
  });
}

function displayTimings(timings: any) {
  const badgesEl = $('#badges');
  
  // Clear previous timing badges
  const existingTiming = badgesEl.querySelectorAll('.timing');
  existingTiming.forEach(el => el.remove());
  
  // Calculate total
  const total = Object.values(timings).reduce((sum: number, time: any) => sum + (time || 0), 0);
  
  // Add timing badge
  const timingEl = document.createElement('span');
  timingEl.className = `badge timing ${total > 2500 ? 'bad' : total > 1500 ? 'warn' : 'ok'}`;
  timingEl.textContent = `${Math.round(total)}ms`;
  timingEl.title = `OCR: ${Math.round(timings.ocr || 0)}ms, Total: ${Math.round(total)}ms`;
  badgesEl.appendChild(timingEl);
}

function showTop3Selection(top3: any[]) {
  // For now, just show the button - in full implementation would show radio selection
  btnAcceptTop3.hidden = false;
  btnAccept.disabled = true; btnTestAll.disabled = false; // Disable auto accept but allow testing
}

function displayROIMetrics(rois: any[]) {
  // Display individual field metrics
  const fieldNames = ['name', 'hp', 'set_number'];
  
  fieldNames.forEach(field => {
    const metricsEl = $(`#metrics-${field}`) as HTMLElement;
    const roi = rois.find((r: any) => r.field === field);
    
    const mx = roi ? (roi.metrics || roi.aux) : null;
    if (roi && mx) {
      const coveragePct = Math.round(mx.coverage?.coverage_pct || 0);
      const clarityScore = Math.round(mx.edge_clarity_score || 0);
      const minSizeOk = mx.min_crop_check?.meets_min_size;
      
      // Update individual field metrics
      const coveragePctEl = metricsEl.querySelector('.coverage-pct') as HTMLElement;
      const clarityScoreEl = metricsEl.querySelector('.clarity-score') as HTMLElement;
      if (coveragePctEl) coveragePctEl.textContent = coveragePct.toString();
      if (clarityScoreEl) clarityScoreEl.textContent = clarityScore.toString();
      
      // Color-code based on quality
      const coverageEl = metricsEl.querySelector('.coverage') as HTMLElement;
      const clarityEl = metricsEl.querySelector('.clarity') as HTMLElement;
      
      if (coverageEl) {
        coverageEl.className = 'coverage ' + (coveragePct >= 7 ? 'good' : coveragePct >= 3 ? 'warn' : 'bad');
      }
      if (clarityEl) {
        clarityEl.className = 'clarity ' + (clarityScore >= 60 ? 'good' : clarityScore >= 30 ? 'warn' : 'bad');
      }
      
      metricsEl.style.display = 'block';
    } else {
      metricsEl.style.display = 'none';
    }
  });
  
  // Display aggregate ROI coverage details
  const roiDetailsEl = $('#roi-coverage-details') as HTMLElement;
  if (roiDetailsEl) {
    let html = '<div class="roi-summary">';
    rois.forEach((roi: any) => {
      const mx = roi.metrics || roi.aux;
      if (mx) {
        const coverage = mx.coverage?.coverage_pct || 0;
        const clarity = mx.edge_clarity_score || 0;
        const minCheck = mx.min_crop_check;
        const margins = mx.coverage?.margins || {};
        
        html += `
          <div class="roi-detail" data-field="${roi.field}">
            <h4>${roi.field.toUpperCase()}</h4>
            <p>Coverage: ${Math.round(coverage)}% (Target: 3-10%)</p>
            <p>Edge Clarity: ${Math.round(clarity)} (Target: >60)</p>
            <p>Margins: L${Math.round(margins.left || 0)}% R${Math.round(margins.right || 0)}% T${Math.round(margins.top || 0)}% B${Math.round(margins.bottom || 0)}%</p>
            <p>Size: ${minCheck?.actual_size?.width || 0}×${minCheck?.actual_size?.height || 0}px 
               ${minCheck?.meets_min_size ? '✅' : '❌'}</p>
            ${minCheck?.warnings?.length ? `<p class="warnings">⚠️ ${minCheck.warnings.join(', ')}</p>` : ''}
          </div>
        `;
      }
    });
    html += '</div>';
    roiDetailsEl.innerHTML = html;
  }
}

function displayNormalizationTelemetry(events: any[]) {
  const countEl = $('#norm-event-count') as HTMLElement;
  const eventsEl = $('#normalization-events') as HTMLElement;
  
  if (countEl) countEl.textContent = events.length.toString();
  
  if (eventsEl && events.length > 0) {
    let html = '<div class="norm-events">';
    events.forEach((event: any, idx: number) => {
      html += `
        <div class="norm-event" data-field="${event.field}">
          <span class="field-label">${event.field}:</span>
          <span class="rule-id">${event.rule_id}</span>
          <span class="transformation">"${event.before}" → "${event.after}"</span>
        </div>
      `;
    });
    html += '</div>';
    eventsEl.innerHTML = html;
  } else if (eventsEl) {
    eventsEl.innerHTML = '<p>No normalization events</p>';
  }
}

async function accept() {
  if (!lastScanId) return;
  try {
    // Include roiVersion and Idempotency-Key to satisfy governance
    const maxVersion = Math.max(
      roiVersion['name'] || 0,
      roiVersion['hp'] || 0,
      roiVersion['set_number'] || 0
    );
    const idemKey = `accept:${lastScanId}:${maxVersion}`;
    const r = await fetch(apiBase + '/api/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
      body: JSON.stringify({ scan_id: lastScanId, roiVersion: maxVersion })
    });
    
    // Handle 409 Conflict (stale roiVersion) with specific user guidance
    if (r.status === 409) {
      const errorData = await r.json().catch(() => ({}));
      if (errorData.error === 'stale_roi_version') {
        toast('ROI changed since last test. Please re-test affected fields before accepting.', 'bad');
        // Suggest re-testing by enabling the Test All button
        btnTestAll.disabled = false;
        return;
      }
    }
    
    if (!r.ok) throw new Error(`accept_failed: ${r.status}`);
    toast('Saved to inventory', 'ok');
  } catch (e) {
    console.error(e); toast('Save failed', 'bad');
  }
}

function recap() {
  lastScanId = undefined; btnAccept.disabled = true; btnRecap.disabled = true; btnTestAll.disabled = true; btnAcceptTop3.hidden = true; toast('Recapture requested', 'warn');
}

async function testROI(field: string, cropDataUrl: string) {
  try {
    toast(`Testing ${field} ROI...`);
    
    const response = await fetch(apiBase + '/api/roi/ocr-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        crop_base64: cropDataUrl,
        field: field,
        retry_upscale: true, // Enable retry upscale for better results
        roiVersion: roiVersion[field] || 0,
        rid: ++lastRid[field],
        scan_id: lastScanId,
        max_length: field === 'name' ? 50 : 10,
        whitelist: ['hp', 'set_number', 'card_number'].includes(field) ? '0123456789/' : null
      })
    });
    
    if (!response.ok) throw new Error('ROI test failed');
    
    const result = await response.json();
    
    // Anti-stale: only render if response rid matches lastRid
    if (result.rid !== undefined && result.rid !== lastRid[field]) return;
    
    displayROITestResult(field, result);
    
    // Still show toast for quick feedback
    const confidence = Math.round((result.confidence || 0) * 100);
    const regexStatus = result.regex_ok ? '✓' : '✗';
    toast(`${field}: "${result.text_norm || result.text}" ${regexStatus} (${confidence}%)`, result.regex_ok ? 'ok' : 'warn');
    
  } catch (error) {
    console.error('ROI test failed:', error);
    toast(`ROI test failed: ${error}`, 'bad');
    hideROITestResult(field);
  }
}

function displayROITestResult(field: string, result: any) {
  const testResultsEl = $(`#test-results-${field}`) as HTMLElement;
  const elapsedEl = testResultsEl.querySelector('.elapsed-ms') as HTMLElement;
  const regexBadgeEl = $(`#regex-badge-${field}`) as HTMLElement;
  const confidenceValueEl = testResultsEl.querySelector('.confidence-value') as HTMLElement;
  const qualityWarningsEl = $(`#quality-warnings-${field}`) as HTMLElement;
  
  if (!testResultsEl) return;
  
  // Show the results section
  testResultsEl.style.display = 'flex';
  
  // Elapsed time
  if (elapsedEl && result.elapsed_ms !== undefined) {
    elapsedEl.textContent = result.elapsed_ms.toFixed(1);
  }
  
  // Regex badge
  if (regexBadgeEl) {
    regexBadgeEl.textContent = result.regex_ok ? '✓' : '✗';
    regexBadgeEl.className = `regex-badge ${result.regex_ok ? 'pass' : 'fail'}`;
  }
  
  // Confidence with color coding
  if (confidenceValueEl && result.confidence !== undefined) {
    const confidence = Math.round(result.confidence * 100);
    confidenceValueEl.textContent = confidence.toString();
    
    // Color coding: >90% green, >70% yellow, <70% red
    confidenceValueEl.className = 'confidence-value';
    if (confidence > 90) {
      confidenceValueEl.classList.add('high');
    } else if (confidence > 70) {
      confidenceValueEl.classList.add('medium');
    } else {
      confidenceValueEl.classList.add('low');
    }
  }
  
  // Quality warnings based on lap_var and tenengrad
  if (qualityWarningsEl) {
    const warnings = [];
    
    if (result.lap_var !== undefined && result.lap_var < 100) {
      warnings.push('Low sharpness');
    }
    
    if (result.tenengrad !== undefined && result.tenengrad < 50) {
      warnings.push('Poor focus');
    }
    
    if (warnings.length > 0) {
      qualityWarningsEl.innerHTML = warnings
        .map(warning => `<span class="quality-warning">${warning}</span>`)
        .join('');
    } else {
      qualityWarningsEl.innerHTML = '';
    }
  }
}

function hideROITestResult(field: string) {
  const testResultsEl = $(`#test-results-${field}`) as HTMLElement;
  if (testResultsEl) {
    testResultsEl.style.display = 'none';
  }
}

async function testAllROIs() {
  if (!currentScanData?.crops) {
    toast('No scan data available for testing', 'bad');
    return;
  }

  const btnTestAll = $('#btn-test-all') as HTMLButtonElement;
  const modal = $('#test-all-modal') as HTMLElement;
  const fields = ['name', 'hp', 'set_number'];
  
  // Cancel any previous batch
  if (batchAbort) {
    batchAbort.abort();
  }
  batchAbort = new AbortController();
  
  // Disable button and show modal
  btnTestAll.disabled = true;
  btnTestAll.textContent = 'Testing...';
  modal.style.display = 'flex';
  
  const results: any[] = [];
  let totalTime = 0;
  
  try {
    // Process fields with concurrency control
    const semaphore = new Array(MAX_CONCURRENT).fill(null);
    const promises = fields.map(async (field, index) => {
      if (!currentScanData.crops[field]) {
        return;
      }
      
      // Wait for semaphore slot
      const slotIndex = index % MAX_CONCURRENT;
      await semaphore[slotIndex];
      
      const fieldResult = $('.field-result[data-field="' + field + '"]') as HTMLElement;
      if (fieldResult) {
        fieldResult.classList.add('testing');
      }
      
      const startTime = performance.now();
      
      try {
        const response = await fetch(apiBase + '/api/roi/ocr-test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            crop_base64: currentScanData.crops[field],
            field: field,
            retry_upscale: true,
            roiVersion: roiVersion[field] || 0,
            rid: ++lastRid[field],
            scan_id: lastScanId,
            max_length: field === 'name' ? 50 : 10,
            whitelist: ['hp', 'set_number', 'card_number'].includes(field) ? '0123456789/' : null
          }),
          signal: batchAbort?.signal
        });
        
        if (response.ok) {
          const result = await response.json();
          
          // Anti-stale: only process if rid matches
          if (result.rid !== undefined && result.rid !== lastRid[field]) return;
          
          const elapsed = performance.now() - startTime;
          
          result.field = field;
          result.client_elapsed = elapsed;
          results.push(result);
          totalTime += result.elapsed_ms || 0;
          
          // Update the modal field result immediately
          updateModalFieldResult(field, result);
        }
      } catch (error) {
        if (error.name === 'AbortError') return; // Batch was cancelled
        
        console.error(`Failed to test ${field}:`, error);
        results.push({
          field: field,
          text_norm: 'ERROR',
          confidence: 0,
          regex_ok: false,
          elapsed_ms: 0,
          client_elapsed: performance.now() - startTime
        });
      }
      
      if (fieldResult) {
        fieldResult.classList.remove('testing');
      }
      
      // Release semaphore slot
      semaphore[slotIndex] = Promise.resolve();
    });
    
    await Promise.allSettled(promises);
    
    // Update total time
    const totalTimeEl = $('#total-ocr-time') as HTMLElement;
    totalTimeEl.textContent = totalTime.toFixed(1);
    
    // Update timing bars based on relative performance
    const maxTime = Math.max(...results.map(r => r.elapsed_ms || 0));
    results.forEach(result => {
      const fieldEl = $('.field-result[data-field="' + result.field + '"]') as HTMLElement;
      if (fieldEl && maxTime > 0) {
        const fillEl = fieldEl.querySelector('.timing-fill') as HTMLElement;
        const percentage = ((result.elapsed_ms || 0) / maxTime) * 100;
        fillEl.style.width = `${percentage}%`;
      }
    });
    
  } finally {
    // Re-enable button
    btnTestAll.disabled = false;
    btnTestAll.textContent = 'Test All (T)';
  }
}

function updateModalFieldResult(field: string, result: any) {
  const fieldEl = $('.field-result[data-field="' + field + '"]') as HTMLElement;
  if (!fieldEl) return;
  
  const textEl = fieldEl.querySelector('.field-text') as HTMLElement;
  const confidenceEl = fieldEl.querySelector('.field-confidence') as HTMLElement;
  const regexEl = fieldEl.querySelector('.field-regex') as HTMLElement;
  const elapsedEl = fieldEl.querySelector('.field-elapsed') as HTMLElement;
  
  if (textEl) {
    textEl.textContent = result.text_norm || result.text || '—';
  }
  
  if (confidenceEl) {
    const confidence = Math.round((result.confidence || 0) * 100);
    confidenceEl.textContent = `${confidence}%`;
    confidenceEl.className = 'field-confidence';
    if (confidence > 90) confidenceEl.classList.add('high');
    else if (confidence > 70) confidenceEl.classList.add('medium');
    else confidenceEl.classList.add('low');
  }
  
  if (regexEl) {
    regexEl.textContent = result.regex_ok ? '✓' : '✗';
    regexEl.className = `field-regex ${result.regex_ok ? 'pass' : 'fail'}`;
  }
  
  if (elapsedEl) {
    elapsedEl.textContent = `${(result.elapsed_ms || 0).toFixed(1)}ms`;
  }
}

function closeTestAllModal() {
  const modal = $('#test-all-modal') as HTMLElement;
  modal.style.display = 'none';
  
  // Reset modal state
  const fields = ['name', 'hp', 'set_number'];
  fields.forEach(field => {
    const fieldEl = $('.field-result[data-field="' + field + '"]') as HTMLElement;
    if (fieldEl) {
      const fillEl = fieldEl.querySelector('.timing-fill') as HTMLElement;
      if (fillEl) fillEl.style.width = '0%';
    }
  });
  
  const totalTimeEl = $('#total-ocr-time') as HTMLElement;
  totalTimeEl.textContent = '—';
}

function copyDevPayload(scanData: any) {
  const devPayload = {
    scan_id: scanData.scan_id,
    emissions: scanData.emissions,
    dev: scanData.dev,
    timings_ms: scanData.timings_ms,
    fields: scanData.fields,
    conf: scanData.conf,
    decision: scanData.decision,
    rois: scanData.rois?.map((r: any) => ({
      field: r.field,
      box: r.box,
      metrics: r.metrics || r.aux
    }))
  };
  
  try {
    navigator.clipboard.writeText(JSON.stringify(devPayload, null, 2));
    toast('Dev payload copied to clipboard', 'ok');
  } catch (error) {
    console.error('Failed to copy:', error);
    toast('Copy failed', 'bad');
  }
}

// North Star Functions for Operator UI

function displayOperatorEmissions(emissions: any[]) {
  const emissionsList = $('#emissions-list') as HTMLElement;
  
  if (!emissions || emissions.length === 0) {
    emissionsList.innerHTML = '<p class="no-emissions">System is working smoothly!</p>';
    return;
  }
  
  let html = '';
  emissions.forEach(emission => {
    const level = emission.level;
    const message = emission.message;
    const nextAction = emission.next_action;
    const code = emission.code;
    
    // Convert to operator-friendly messages
    let operatorMessage = message;
    let operatorAction = nextAction;
    
    switch (code) {
      case 'NAME_LOW_CONF':
        operatorMessage = "Card name confidence is low. I'll show you the top 3 options to choose from.";
        operatorAction = "Pick the correct name from the list below.";
        break;
      case 'HP_CLAMPED':
        operatorMessage = `HP looks like '${emission.dev?.raw}' but I think it should be '${emission.dev?.normalized}'.`;
        operatorAction = "Click Accept to use the corrected value.";
        break;
      case 'SETNUM_REGEX_FAIL':
        operatorMessage = "Set number format looks off (should be like 115/130). The image might be blurry.";
        operatorAction = "Try recapturing with better focus on the bottom corner.";
        break;
      case 'NO_FIELD_ROIS':
        operatorMessage = "I couldn't find the text areas clearly. The card might be too dark or cut off.";
        operatorAction = "Use better lighting and make sure the whole card is in the frame.";
        break;
    }
    
    html += `
      <div class="emission ${level}">
        <div class="emission-message">${operatorMessage}</div>
        <div class="emission-action">${operatorAction}</div>
      </div>
    `;
  });
  
  emissionsList.innerHTML = html;
}

function displayROIStatus(rois: any[]) {
  ['name', 'hp', 'set_number'].forEach(field => {
    const statusEl = $(`#status-${field}`) as HTMLElement;
    const roi = rois.find(r => r.field === field);
    
    if (!roi || !roi.metrics) {
      statusEl.textContent = 'No data';
      statusEl.className = 'roi-status';
      return;
    }
    
    const coverage = roi.metrics.coverage?.coverage_pct || 0;
    const clarity = roi.metrics.edge_clarity_score || 0;
    const minSize = roi.metrics.min_crop_check?.meets_min_size;
    
    let status = '';
    let className = 'roi-status ';
    
    if (!minSize || coverage < 3 || clarity < 30) {
      status = 'PROBLEM';
      className += 'problem';
    } else if (coverage < 5 || clarity < 50) {
      status = 'CHECK';
      className += 'warning';
    } else if (coverage >= 7 && clarity >= 60) {
      status = 'GOOD';
      className += 'good';
    } else {
      status = 'OK';
      className += 'good';
    }
    
    statusEl.textContent = status;
    statusEl.className = className;
  });
}

function updateSessionMetrics(scanData: any) {
  sessionMetrics.cardsProcessed++;
  
  // Calculate total processing time
  const timings = scanData.timings_ms || {};
  const totalTime = Object.values(timings).reduce((sum: number, time: any) => sum + (time || 0), 0);
  sessionMetrics.totalProcessingTime += totalTime;
  
  // Update UI
  $('#session-cards-count').textContent = sessionMetrics.cardsProcessed.toString();
  $('#session-avg-time').textContent = Math.round(sessionMetrics.totalProcessingTime / sessionMetrics.cardsProcessed) + 'ms';
  
  if (sessionMetrics.improvementsMade > 0) {
    $('#session-improvements').textContent = sessionMetrics.improvementsMade.toString();
    $('#session-avg-boost').textContent = Math.round(sessionMetrics.totalConfidenceBoost / sessionMetrics.improvementsMade) + '%';
  }
}

// Open ROI editor for a field (mounts Canvas-based editor)
async function adjustROI(field: 'name'|'hp'|'set_number') {
  const host = document.getElementById('roi-editor-host')!;
  host.hidden = false;
  
  const { RoiEditorLSF } = await import('./roi-editor-lsf.js');
  const editor = new RoiEditorLSF(host, (box) => {
    // Apply edit to scan data and bump version
    const roi = currentScanData.rois.find((r: any) => r.field === field);
    if (roi) { 
      roi.box = [box.x, box.y, box.x + box.w, box.y + box.h];
      roiVersion[field] = (roiVersion[field] || 0) + 1;
      drawRois(currentScanData.rois);
      
      // Track this as an improvement
      sessionMetrics.improvementsMade++;
      sessionMetrics.improvements.push({
        field: field,
        change: `Adjusted ROI to ${box.x},${box.y} ${box.w}×${box.h}`,
        timestamp: new Date().toISOString()
      });
      
      displayRecentImprovements();
      toast(`${field.toUpperCase()} ROI updated`, 'ok');
      
      // Enable save to template button
      const saveToTemplateBtn = $('#btn-save-to-template') as HTMLButtonElement;
      saveToTemplateBtn.disabled = false;
    }
  });
  
  // Get current ROI and OCR text for this field
  let currentROI = undefined;
  let currentOCRText = undefined;
  if (currentScanData?.rois) {
    const roi = currentScanData.rois.find((r: any) => r.field === field);
    if (roi?.box) {
      const [x1, y1, x2, y2] = roi.box;
      currentROI = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
  }
  
  // Get current OCR text value
  if (currentScanData?.fields?.[field]?.value) {
    currentOCRText = currentScanData.fields[field].value;
  }
  
  editor.mount(currentScanData.image_url || currentScanData.image_path, field, currentROI, currentOCRText);
  
  // Esc to close
  const onKey = (e: KeyboardEvent) => { 
    if (e.key === 'Escape') { 
      host.hidden = true; 
      editor.destroy(); 
      document.removeEventListener('keydown', onKey);
    } 
  };
  document.addEventListener('keydown', onKey);
}

function displayRecentImprovements() {
  const improvementsList = $('#improvements-list') as HTMLElement;
  
  if (sessionMetrics.improvements.length === 0) {
    improvementsList.innerHTML = '<p>No improvements yet this session</p>';
    return;
  }
  
  let html = '';
  sessionMetrics.improvements.slice(-10).forEach(improvement => {
    const time = new Date(improvement.timestamp).toLocaleTimeString();
    html += `
      <div class="improvement">
        <span class="improvement-field">${improvement.field.toUpperCase()}:</span>
        ${improvement.change}
        <span class="improvement-time">${time}</span>
      </div>
    `;
  });
  
  improvementsList.innerHTML = html;
}

async function saveToTemplate() {
  if (!currentScanData?.rois) {
    toast('No ROI data to save', 'bad');
    return;
  }
  
  const eraSelect = $('#era-select') as HTMLSelectElement;
  const selectedEra = eraSelect.value;
  
  try {
    // Get current template
    const templateResponse = await fetch(apiBase + '/api/roi/manifest');
    if (!templateResponse.ok) throw new Error('Failed to load template');
    
    const template = await templateResponse.json();
    
    // Update ROI coordinates in template
    currentScanData.rois.forEach((roi: any) => {
      if (template.templates?.[selectedEra]?.field_rois?.[roi.field]) {
        const [x1, y1, x2, y2] = roi.box;
        // Convert absolute coordinates to percentages (assuming canvas is scaled version)
        const imageWidth = canvas.width;
        const imageHeight = canvas.height;
        
        template.templates[selectedEra].field_rois[roi.field] = {
          x_pct: Math.round((x1 / imageWidth) * 100),
          y_pct: Math.round((y1 / imageHeight) * 100),
          width_pct: Math.round(((x2 - x1) / imageWidth) * 100),
          height_pct: Math.round(((y2 - y1) / imageHeight) * 100)
        };
      }
    });
    
    // Save updated template
    const saveResponse = await fetch(apiBase + '/api/admin/roi-manifest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(template)
    });
    
    if (!saveResponse.ok) throw new Error('Failed to save template');
    
    const result = await saveResponse.json();
    $('#template-status').textContent = `Saved to ${selectedEra} template`;
    toast(`Template updated for ${selectedEra}`, 'ok');
    
    // Track this as a major improvement
    sessionMetrics.improvements.push({
      field: 'template',
      change: `Saved ROI adjustments to ${selectedEra} template`,
      timestamp: new Date().toISOString()
    });
    
    displayRecentImprovements();
    
    // Disable save button until next change
    ($('#btn-save-to-template') as HTMLButtonElement).disabled = true;
    
  } catch (error) {
    console.error('Save to template failed:', error);
    toast('Failed to save template', 'bad');
  }
}

function main() {
  wireDropzone();
  btnScan.addEventListener('click', scanFile);
  btnAccept.addEventListener('click', accept);
  btnRecap.addEventListener('click', recap);
  
  // Manifest save wiring
  const btnSaveManifest = document.getElementById('btn-save-manifest') as HTMLButtonElement;
  const manifestFile = document.getElementById('manifest-file') as HTMLInputElement;
  const manifestStatus = document.getElementById('manifest-status') as HTMLElement;
  if (btnSaveManifest && manifestFile) {
    btnSaveManifest.addEventListener('click', async () => {
      try {
        const file = manifestFile.files?.[0];
        if (!file) { toast('No manifest selected', 'bad'); return; }
        const text = await file.text();
        // Validate JSON
        try { JSON.parse(text); } catch (e) { toast('Invalid JSON file', 'bad'); return; }
        const r = await fetch(apiBase + '/api/admin/roi-manifest', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text
        });
        if (!r.ok) throw new Error('save_failed');
        const out = await r.json();
        manifestStatus.textContent = `Saved. new_hash=${out.new_hash?.slice(0,8)} backup=${out.backup_path ? 'yes' : 'no'}`;
        toast('Manifest saved', 'ok');
      } catch (err) {
        console.error(err);
        manifestStatus.textContent = 'Save failed';
        toast('Manifest save failed', 'bad');
      }
    });
  }
  
  // Wire up North Star buttons
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    
    // Test ROI button
    if (target.classList.contains('test-roi-btn')) {
      const field = target.getAttribute('data-field');
      if (field && currentScanData?.crops?.[field]) {
        testROI(field, currentScanData.crops[field]);
      }
    }
    
    // Adjust ROI button
    if (target.classList.contains('adjust-roi-btn')) {
      const field = target.getAttribute('data-field');
      if (field) {
        adjustROI(field);
      }
    }
  });
  
  // Wire up copy dev payload button
  const copyBtn = $('#copy-dev-payload') as HTMLButtonElement;
  copyBtn?.addEventListener('click', () => {
    if (currentScanData) {
      copyDevPayload(currentScanData);
    }
  });
  
  // Wire up template management
  const saveToTemplateBtn = $('#btn-save-to-template') as HTMLButtonElement;
  saveToTemplateBtn?.addEventListener('click', saveToTemplate);
  
  const loadTemplateBtn = $('#btn-load-template') as HTMLButtonElement;
  loadTemplateBtn?.addEventListener('click', async () => {
    try {
      const response = await fetch(apiBase + '/api/roi/manifest');
      if (!response.ok) throw new Error('Failed to load template');
      
      const manifest = await response.json();
      const eraSelect = $('#era-select') as HTMLSelectElement;
      const selectedEra = eraSelect.value;
      
      if (manifest.templates?.[selectedEra]) {
        $('#template-status').textContent = `Loaded ${selectedEra} template`;
        toast(`${selectedEra} template loaded`, 'ok');
      } else {
        throw new Error(`Template ${selectedEra} not found`);
      }
    } catch (error) {
      console.error('Load template failed:', error);
      toast('Failed to load template', 'bad');
    }
  });
  
  // Wire up Test All button
  const btnTestAll = $('#btn-test-all') as HTMLButtonElement;
  btnTestAll?.addEventListener('click', testAllROIs);
  
  // Wire up Test All modal close button
  const modalClose = $('.modal-close') as HTMLButtonElement;
  modalClose?.addEventListener('click', closeTestAllModal);
  
  // Close modal when clicking outside
  const modal = $('#test-all-modal') as HTMLElement;
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeTestAllModal();
    }
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Only handle shortcuts when not typing in an input
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    
    // Test All (T key)
    if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!btnTestAll.disabled && currentScanData?.crops) {
        testAllROIs();
      }
    }
    
    // Close modal (Escape key)
    if (e.key === 'Escape') {
      const modal = $('#test-all-modal') as HTMLElement;
      if (modal && modal.style.display === 'flex') {
        closeTestAllModal();
      }
    }
  });
  
  // Initialize session metrics display
  displayRecentImprovements();
  
  ping(); setInterval(ping, 5000);
}

main();
