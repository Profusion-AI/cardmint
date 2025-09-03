var L=Object.defineProperty;var A=(t,e,n)=>e in t?L(t,e,{enumerable:!0,configurable:!0,writable:!0,value:n}):t[e]=n;var d=(t,e,n)=>A(t,typeof e!="symbol"?e+"":e,n);import"./banner-BpERPkmb.js";import"./main-DYFpucq2.js";const E=[{href:"/dashboard/",label:"Dashboard Hub",icon:"🏠",description:"Main navigation and system overview"},{href:"/processing-status.html",label:"Processing Status",icon:"📊",description:"Real-time processing pipeline monitoring"},{href:"/dashboard/performance.html",label:"Performance Monitor",icon:"⚡",description:"System performance metrics and SLA tracking"},{href:"/dashboard/verification.html",label:"Card Verification",icon:"✅",description:"Review and validate processed cards"},{href:"/dashboard/ensemble-dashboard.html",label:"Batch Results",icon:"📦",description:"Ensemble processing results and exports"},{href:"/dashboard/health.html",label:"System Health",icon:"🏥",description:"System monitoring and diagnostics"}];function D(t=""){const e=E.find(o=>t===o.href||t==="/dashboard"&&o.href==="/dashboard/"||t.endsWith(o.href.split("/").pop()||"")),n=e?[{href:"/dashboard/",label:"Dashboard"},{href:e.href,label:e.label}]:[{href:"/dashboard/",label:"Dashboard"}];return`
    <nav class="dashboard-nav" id="dashboard-nav">
      <div class="nav-container">
        <div class="nav-brand">
          <a href="/dashboard/" class="brand-link">
            <span class="brand-icon">🃏</span>
            <span class="brand-text">CardMint</span>
            <span class="brand-subtitle">v2.0</span>
          </a>
        </div>
        
        <div class="nav-breadcrumbs">
          ${n.map((o,s)=>`
            <a href="${o.href}" class="breadcrumb ${s===n.length-1?"active":""}">
              ${o.label}
            </a>
            ${s<n.length-1?'<span class="separator">›</span>':""}
          `).join("")}
        </div>
        
        <div class="nav-actions">
          <div class="nav-dropdown" id="nav-dropdown">
            <button class="nav-dropdown-toggle" id="nav-dropdown-toggle" aria-expanded="false" aria-haspopup="true" aria-controls="nav-dropdown-menu">
              <span class="current-page">${(e==null?void 0:e.icon)||"🏠"} ${(e==null?void 0:e.label)||"Dashboard"}</span>
              <span class="dropdown-arrow">▾</span>
            </button>
            <div class="nav-dropdown-menu" id="nav-dropdown-menu" role="menu" aria-labelledby="nav-dropdown-toggle">
              ${E.map(o=>`
                <a href="${o.href}" class="nav-dropdown-item ${t.includes(o.href)?"active":""}" role="menuitem" tabindex="-1">
                  <span class="item-icon">${o.icon}</span>
                  <div class="item-content">
                    <div class="item-label">${o.label}</div>
                    <div class="item-description">${o.description}</div>
                  </div>
                </a>
              `).join("")}
            </div>
          </div>
          
          <div class="nav-status" id="nav-status">
            <div class="status-indicator" id="system-status" aria-live="polite">
              <span class="status-dot offline"></span>
              <span class="status-text">Connecting...</span>
            </div>
          </div>
        </div>
      </div>
    </nav>
  `}function N(){return`
    <style>
      .dashboard-nav {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(10px);
        border-bottom: 1px solid rgba(0, 0, 0, 0.1);
        z-index: 1000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
      }
      
      .nav-container {
        display: flex;
        align-items: center;
        justify-content: space-between;
        max-width: 1400px;
        margin: 0 auto;
        padding: 12px 24px;
        gap: 20px;
      }
      
      .nav-brand {
        flex-shrink: 0;
      }
      
      .brand-link {
        display: flex;
        align-items: center;
        gap: 8px;
        text-decoration: none;
        color: #2d3748;
        font-weight: 600;
        transition: color 0.2s;
      }
      
      .brand-link:hover {
        color: #667eea;
      }
      
      .brand-icon {
        font-size: 1.5rem;
      }
      
      .brand-text {
        font-size: 1.2rem;
        font-weight: 700;
      }
      
      .brand-subtitle {
        font-size: 0.8rem;
        color: #718096;
        background: #e2e8f0;
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: 500;
      }
      
      .nav-breadcrumbs {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.9rem;
        color: #718096;
      }
      
      .breadcrumb {
        text-decoration: none;
        color: #718096;
        padding: 4px 8px;
        border-radius: 4px;
        transition: all 0.2s;
      }
      
      .breadcrumb:hover {
        background: #f7fafc;
        color: #2d3748;
      }
      
      .breadcrumb.active {
        color: #667eea;
        font-weight: 600;
      }
      
      .separator {
        color: #cbd5e0;
        user-select: none;
      }
      
      .nav-actions {
        display: flex;
        align-items: center;
        gap: 16px;
        flex-shrink: 0;
      }
      
      .nav-dropdown {
        position: relative;
      }
      
      .nav-dropdown-toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        background: #f7fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 0.9rem;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .nav-dropdown-toggle:hover {
        background: #edf2f7;
        border-color: #cbd5e0;
      }
      
      .nav-dropdown-toggle.active {
        background: #667eea;
        color: white;
        border-color: #667eea;
      }
      
      .current-page {
        font-weight: 600;
      }
      
      .dropdown-arrow {
        font-size: 0.8rem;
        transition: transform 0.2s;
      }
      
      .nav-dropdown.open .dropdown-arrow {
        transform: rotate(180deg);
      }
      
      .nav-dropdown-menu {
        position: absolute;
        top: 100%;
        right: 0;
        background: white;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
        min-width: 300px;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-10px);
        transition: all 0.2s;
        z-index: 1001;
      }
      
      .nav-dropdown.open .nav-dropdown-menu {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      
      .nav-dropdown-item {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 12px 16px;
        text-decoration: none;
        color: #2d3748;
        border-bottom: 1px solid #f7fafc;
        transition: background 0.2s;
      }
      
      .nav-dropdown-item:hover {
        background: #f7fafc;
      }
      
      .nav-dropdown-item.active {
        background: #ebf8ff;
        border-left: 3px solid #667eea;
      }
      
      .nav-dropdown-item:last-child {
        border-bottom: none;
      }
      
      .item-icon {
        font-size: 1.2rem;
        flex-shrink: 0;
        margin-top: 2px;
      }
      
      .item-content {
        flex: 1;
      }
      
      .item-label {
        font-weight: 600;
        margin-bottom: 2px;
        font-size: 0.9rem;
      }
      
      .item-description {
        font-size: 0.8rem;
        color: #718096;
        line-height: 1.3;
      }
      
      .nav-status {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .status-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.85rem;
        padding: 6px 10px;
        background: #f7fafc;
        border-radius: 6px;
        border: 1px solid #e2e8f0;
      }
      
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        animation: pulse 2s infinite;
      }
      
      .status-dot.online {
        background: #10b981;
      }
      
      .status-dot.offline {
        background: #ef4444;
      }
      
      .status-dot.warning {
        background: #f59e0b;
      }
      
      .status-text {
        font-weight: 500;
      }
      
      @keyframes pulse {
        0% { opacity: 1; }
        50% { opacity: 0.5; }
        100% { opacity: 1; }
      }
      
      /* Respect reduced motion preferences */
      @media (prefers-reduced-motion: reduce) {
        .status-dot { animation: none !important; }
        * { transition: none !important; }
      }
      
      /* Responsive */
      @media (max-width: 768px) {
        .nav-container {
          padding: 10px 16px;
          gap: 12px;
        }
        
        .nav-breadcrumbs {
          display: none;
        }
        
        .brand-text {
          font-size: 1.1rem;
        }
        
        .nav-dropdown-menu {
          min-width: 250px;
          right: -16px;
        }
        
        .current-page {
          max-width: 120px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }
      
      /* Add margin to page content to account for fixed nav */
      body {
        padding-top: 70px;
      }
      
      /* Focus styles for accessibility */
      button:focus-visible,
      a:focus-visible {
        outline: 2px solid #667eea;
        outline-offset: 2px;
        border-radius: 4px;
      }
      
      .dashboard-container,
      .container,
      .main-panel {
        margin-top: 0;
      }
    </style>
  `}function C(){const t=document.getElementById("nav-dropdown-toggle"),e=document.getElementById("nav-dropdown"),n=document.getElementById("nav-dropdown-menu");t&&e&&n&&(t.addEventListener("click",s=>{s.stopPropagation();const a=e.classList.contains("open");e.classList.toggle("open"),t.setAttribute("aria-expanded",(!a).toString()),n.querySelectorAll('[role="menuitem"]').forEach((c,f)=>{c.tabIndex=a?-1:0,!a&&f===0&&c.focus()})}),document.addEventListener("click",s=>{e.contains(s.target)||(e.classList.remove("open"),t.setAttribute("aria-expanded","false"),n.querySelectorAll('[role="menuitem"]').forEach(i=>{i.tabIndex=-1}))}),n.addEventListener("keydown",s=>{const a=Array.from(n.querySelectorAll('[role="menuitem"]')),i=a.indexOf(document.activeElement);switch(s.key){case"Escape":e.classList.remove("open"),t.setAttribute("aria-expanded","false"),t.focus(),a.forEach(R=>R.tabIndex=-1);break;case"ArrowDown":s.preventDefault();const c=(i+1)%a.length;a[c].focus();break;case"ArrowUp":s.preventDefault();const f=i>0?i-1:a.length-1;a[f].focus();break}})),S();const o=()=>{S()};if(window.requestIdleCallback){const s=()=>{window.requestIdleCallback(()=>{o(),setTimeout(s,3e4)})};s()}else setInterval(o,3e4)}async function S(){const t=document.getElementById("system-status"),e=t==null?void 0:t.querySelector(".status-dot"),n=t==null?void 0:t.querySelector(".status-text");if(!(!t||!e||!n))try{(await(await fetch("/api/health")).json()).status==="healthy"?(e.className="status-dot online",n.textContent="System Online"):(e.className="status-dot warning",n.textContent="System Issues")}catch{e.className="status-dot offline",n.textContent="System Offline"}}typeof document<"u"&&(document.readyState==="loading"?document.addEventListener("DOMContentLoaded",C):C());document.head.insertAdjacentHTML("beforeend",N());document.addEventListener("DOMContentLoaded",()=>{const t=D("/dashboard/index.html");document.body.insertAdjacentHTML("afterbegin",t),C()});class O{constructor(e={}){d(this,"ws",null);d(this,"url");d(this,"config");d(this,"reconnectAttempts",0);d(this,"reconnectTimer",null);d(this,"heartbeatTimer",null);d(this,"eventHandlers",new Map);d(this,"connected",!1);var n;this.config={maxReconnectAttempts:10,reconnectInterval:1e3,heartbeatInterval:3e4,timeout:5e3,...e},this.url=((n=document.querySelector('meta[name="ws-url"]'))==null?void 0:n.content)||this.getDefaultWebSocketUrl(),this.connect()}getDefaultWebSocketUrl(){const e=location.protocol==="https:"?"wss:":"ws:",n=this.getWebSocketPort();return`${e}//${location.hostname}:${n}`}getWebSocketPort(){const e=parseInt(location.port||"80");return"3001"}connect(){try{this.ws=new WebSocket(this.url),this.ws.onopen=()=>{console.log("[WebSocket] Connected to CardMint server"),this.connected=!0,this.reconnectAttempts=0,this.startHeartbeat(),this.emit("connection",{connected:!0})},this.ws.onmessage=e=>{try{const n=JSON.parse(e.data);this.handleMessage(n)}catch{console.warn("[WebSocket] Failed to parse message:",e.data)}},this.ws.onclose=e=>{this.connected=!1,this.stopHeartbeat(),this.emit("connection",{connected:!1}),!e.wasClean&&this.reconnectAttempts<this.config.maxReconnectAttempts&&this.scheduleReconnect()},this.ws.onerror=e=>{this.emit("error",{error:"WebSocket connection failed"})}}catch{this.emit("connection",{connected:!1}),this.scheduleReconnect()}}handleMessage(e){e.timestamp||(e.timestamp=new Date().toISOString()),(this.eventHandlers.get(e.type)||[]).forEach(o=>{try{o(e)}catch(s){console.error(`[WebSocket] Handler error for ${e.type}:`,s)}}),this.emit("message",e)}scheduleReconnect(){this.reconnectTimer&&clearTimeout(this.reconnectTimer);const e=Math.min(this.config.reconnectInterval*Math.pow(2,this.reconnectAttempts),3e4);console.log(`[WebSocket] Reconnecting in ${e}ms (attempt ${this.reconnectAttempts+1})`),this.reconnectTimer=window.setTimeout(()=>{this.reconnectAttempts++;try{const n=new URL(this.url),o=n.hostname,s=Number(n.port||"3001"),a=[3001,3002,3003,3004],i=a.indexOf(s),c=a[(i+1)%a.length];this.url=`${n.protocol}//${o}:${c}`}catch{}this.connect()},e),this.emit("reconnecting",{attempt:this.reconnectAttempts+1,maxAttempts:this.config.maxReconnectAttempts,delay:e})}startHeartbeat(){this.stopHeartbeat(),this.heartbeatTimer=window.setInterval(()=>{var e;((e=this.ws)==null?void 0:e.readyState)===WebSocket.OPEN&&this.send({type:"ping"})},this.config.heartbeatInterval)}stopHeartbeat(){this.heartbeatTimer&&(clearInterval(this.heartbeatTimer),this.heartbeatTimer=null)}on(e,n){this.eventHandlers.has(e)||this.eventHandlers.set(e,[]),this.eventHandlers.get(e).push(n)}off(e,n){if(!n){this.eventHandlers.delete(e);return}const o=this.eventHandlers.get(e);if(o){const s=o.indexOf(n);s>-1&&o.splice(s,1)}}emit(e,n){(this.eventHandlers.get(e)||[]).forEach(s=>{try{s({type:e,...n})}catch(a){console.error(`[WebSocket] Event handler error for ${e}:`,a)}})}send(e){var n;if(((n=this.ws)==null?void 0:n.readyState)===WebSocket.OPEN)try{return this.ws.send(JSON.stringify(e)),!0}catch(o){console.error("[WebSocket] Failed to send message:",o)}else console.warn("[WebSocket] Cannot send message - not connected");return!1}isConnected(){var e;return this.connected&&((e=this.ws)==null?void 0:e.readyState)===WebSocket.OPEN}disconnect(){this.reconnectTimer&&(clearTimeout(this.reconnectTimer),this.reconnectTimer=null),this.stopHeartbeat(),this.ws&&(this.ws.close(1e3,"Client disconnect"),this.ws=null),this.connected=!1,this.eventHandlers.clear()}getConnectionInfo(){return{connected:this.connected,attempts:this.reconnectAttempts,url:this.url}}}let w=null;function h(){return w||(w=new O),w}function H(t){const e=h();return e.on("queueStatus",t),e.on("cardProcessed",t),e.on("cardFailed",t),e.on("batchProgress",t),()=>{e.off("queueStatus",t),e.off("cardProcessed",t),e.off("cardFailed",t),e.off("batchProgress",t)}}function q(t){const e=h(),n=o=>{t(o.connected===!0)};return e.on("connection",n),t(e.isConnected()),()=>e.off("connection",n)}function W(){const t=h();t.send({action:"getQueueStatus"}),t.send({action:"getMetrics"}),t.send({action:"getCardStatusDistribution"})}class m{static show(e,n="info"){this.hide();const o=document.createElement("div");if(o.className=`connection-toast connection-toast-${n}`,o.innerHTML=`
      <div class="toast-content">
        <span class="toast-icon">${this.getIcon(n)}</span>
        <span class="toast-message">${e}</span>
      </div>
    `,o.style.cssText=`
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${this.getBackgroundColor(n)};
      color: white;
      padding: 12px 18px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: slideInRight 0.3s ease-out;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
    `,!document.getElementById("toast-styles")){const s=document.createElement("style");s.id="toast-styles",s.textContent=`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOutRight {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(100%); opacity: 0; }
        }
      `,document.head.appendChild(s)}document.body.appendChild(o),this.toastElement=o,n!=="error"&&(this.hideTimer=window.setTimeout(()=>this.hide(),4e3))}static hide(){this.hideTimer&&(clearTimeout(this.hideTimer),this.hideTimer=null),this.toastElement&&(this.toastElement.style.animation="slideOutRight 0.3s ease-out forwards",setTimeout(()=>{this.toastElement&&this.toastElement.parentNode&&this.toastElement.parentNode.removeChild(this.toastElement),this.toastElement=null},300))}static getIcon(e){switch(e){case"success":return"✓";case"warning":return"⚠";case"error":return"✗";default:return"ℹ"}}static getBackgroundColor(e){switch(e){case"success":return"rgba(16, 185, 129, 0.9)";case"warning":return"rgba(245, 158, 11, 0.9)";case"error":return"rgba(239, 68, 68, 0.9)";default:return"rgba(59, 130, 246, 0.9)"}}}d(m,"toastElement",null),d(m,"hideTimer",null);typeof document<"u"&&document.addEventListener("DOMContentLoaded",()=>{const t=h();t.on("connection",e=>{e.connected?m.show("Connected to server","success"):m.show("Connection lost","warning")}),t.on("reconnecting",e=>{m.show(`Reconnecting... (${e.attempt}/${e.maxAttempts})`,"info")}),t.on("error",e=>{m.show("Connection error","error")})});var M;(M=document.querySelector('meta[name="ws-url"]'))!=null&&M.content;var $;const k=(($=document.querySelector('meta[name="api-url"]'))==null?void 0:$.content)||"http://localhost:3000",b=[],z=200,U=100;let I="all";const x={load(){try{const t=localStorage.getItem("cardmint-dashboard-prefs");return t?JSON.parse(t):{}}catch{return{}}},save(t){try{const e=this.load();localStorage.setItem("cardmint-dashboard-prefs",JSON.stringify({...e,...t}))}catch(e){console.warn("Could not save preferences:",e)}},get(t,e){const n=this.load();return n[t]!==void 0?n[t]:e},set(t,e){this.save({[t]:e})}},y=h();I=x.get("consoleFilter","all");const F=window.matchMedia("(prefers-reduced-motion: reduce)").matches;(F||x.get("reducedMotion",!1))&&(document.body.dataset.mode="kiosk");const l=document.getElementById("refreshBtn"),v=document.getElementById("pauseBtn"),j=document.getElementById("clearBtn"),B=document.getElementById("connectionStatus");document.getElementById("logContainer");function p(t,e,n,o={}){const s={id:Date.now(),timestamp:new Date().toLocaleTimeString(),type:t,method:e||"",url:n||"",data:o};b.push(s),b.length>z&&b.shift(),T(s)&&X(s)}function T(t){return I==="all"||t.type===I}let u=x.get("consolePaused",!1);function Q(){u=!u,x.set("consolePaused",u);const t=document.getElementById("pauseConsoleBtn");t&&(t.textContent=u?"Resume Console":"Pause Console"),r(u?"Console paused for debugging":"Console resumed","info")}function X(t){if(u)return;const e=document.getElementById("logContainer"),n=document.createElement("div");for(n.className=`log-entry log-${t.type}`,n.appendChild(document.createElement("span")).className="log-time",n.firstChild.textContent=`[${t.timestamp}] `,n.appendChild(document.createTextNode(t.message||`${t.method} ${t.url}`)),e.appendChild(n),e.scrollTop=e.scrollHeight;e.children.length>U;)e.removeChild(e.lastChild)}function r(t,e="info"){p(e,"","",{message:t})}function _(t){B.textContent=t?"Connected":"Disconnected",B.className=`status ${t?"connected":"disconnected"}`}function J(t){if(!t){Y('No queue data available. Click "Refresh Status" to reload.');return}t.capture&&(document.getElementById("captureQueueCount").textContent=t.capture.waiting+t.capture.active),t.processing&&(document.getElementById("processingQueueCount").textContent=t.processing.active,document.getElementById("completedCount").textContent=t.processing.completed,document.getElementById("failedCount").textContent=t.processing.failed)}function Y(t){const e=document.getElementById("logContainer");if(e.children.length===0){const n=document.createElement("div");n.className="log-entry log-info",n.innerHTML=`
                    <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
                    ${t}
                `,e.appendChild(n)}}function V(t){const e=t||{};document.getElementById("capturingCount").textContent=e.capturing||0,document.getElementById("queuedCount").textContent=e.queued||0,document.getElementById("processingCount").textContent=e.processing||0,document.getElementById("processedCount").textContent=e.processed||0,document.getElementById("failedStatusCount").textContent=e.failed||0,document.getElementById("retryingCount").textContent=e.retrying||0}function P(t){if(t.processingLatencyMs&&(document.getElementById("avgProcessingTime").textContent=Math.round(t.processingLatencyMs)+"ms"),t.queueDepth!==void 0&&(document.getElementById("queueDepth").textContent=t.queueDepth),t.memoryUsageMb&&(document.getElementById("memoryUsage").textContent=Math.round(t.memoryUsageMb)+"MB"),t.cpuUsagePercent!==void 0&&(document.getElementById("cpuUsage").textContent=Math.round(t.cpuUsagePercent)+"%"),t.throughputPerMinute!==void 0){document.getElementById("throughputPercentage").textContent=t.throughputPerMinute+" cards/min";const c=Math.min(t.throughputPerMinute/60*100,100);document.getElementById("throughputProgress").style.width=c+"%"}const e=parseInt(document.getElementById("completedCount").textContent)||0,n=parseInt(document.getElementById("failedCount").textContent)||0,o=parseInt(document.getElementById("processingQueueCount").textContent)||0,s=parseInt(document.getElementById("captureQueueCount").textContent)||0,a=e+n+o+s;if(a>0){const i=Math.round(e/a*100);document.getElementById("completionPercentage").textContent=i+"%",document.getElementById("completionProgress").style.width=i+"%";const c=a>0?Math.round(n/a*100):0;document.getElementById("errorRatePercentage").textContent=c+"%",document.getElementById("errorRateProgress").style.width=c+"%"}}q(t=>{_(t),t?(r("WebSocket connected to CardMint server","success"),g()):r("WebSocket disconnected","error")});H(t=>{K(t)});function K(t){switch(t.type){case"queueStatus":J(t.data);break;case"cardStatusDistribution":V(t.data);break;case"performanceMetrics":P(t.data);break;case"batchProgress":r(`Batch progress: ${t.message}`,"info"),t.progress&&P(t.progress);break;case"processingStatus":r(`Processing update: ${t.message}`,t.level||"info");break;case"cardProcessed":r(`Card processed: ${t.cardName||"Unknown"} (${t.processingTime}ms)`,"success"),g();break;case"cardFailed":r(`Card processing failed: ${t.error}`,"error"),g();break;case"error":r("Error: "+t.message,"error");break}}function g(){W()}l.addEventListener("click",async()=>{r("Refreshing status data...","info"),l.disabled=!0,l.textContent="Refreshing...";try{g(),setTimeout(()=>{l.disabled=!1,l.textContent="Refresh Status"},1e3)}catch(t){r("Failed to refresh status: "+t.message,"error"),l.disabled=!1,l.textContent="Retry Refresh"}});v.addEventListener("click",()=>{const t=v.textContent.includes("Resume");y.send({action:t?"resumeProcessing":"pauseProcessing"}),v.textContent=t?"Pause Processing":"Resume Processing",r(t?"Processing resumed":"Processing paused","warning")});j.addEventListener("click",()=>{y.send({action:"clearCompleted"}),r("Clearing completed jobs...","info")});setInterval(()=>{y.isConnected()&&g()},5e3);function G(t){const e=t.target.files[0];e&&Z(e)}function Z(t){const e=document.getElementById("imagePreview"),n=document.getElementById("previewImage"),o=document.getElementById("imageInfo"),s=document.getElementById("imageFileName"),a=document.getElementById("imageSize"),i=document.getElementById("imageDimensions"),c=new FileReader;c.onload=f=>{n.src=f.target.result,s.textContent=t.name,a.textContent=`${Math.round(t.size/1024)}KB`,n.onload=()=>{i.textContent=`${n.naturalWidth}x${n.naturalHeight}`},e.style.display="block",o.style.display="block",p("info","FILE","selected",{fileName:t.name,size:t.size})},c.readAsDataURL(t)}function ee(t){t==null||t.preventDefault(),document.getElementById("imagePreview").style.display="none",document.getElementById("imageInfo").style.display="none",document.getElementById("fileInput").value="",p("info","FILE","cleared")}async function te(){const t=document.getElementById("processingOverlay");t.style.display="flex";try{p("request","POST",`${k}/api/capture`);const e=await fetch(`${k}/api/capture`,{method:"POST"});if(e.ok){const n=await e.json();p("response","POST","/api/capture",{status:e.status,cardId:n.id}),r("Card capture initiated successfully","success")}else p("error","POST","/api/capture",{status:e.status}),r("Card capture failed","error")}catch(e){p("error","POST","/api/capture",{error:e.message}),r("Capture error: "+e.message,"error")}finally{t.style.display="none"}}function ne(){const t=b.filter(T).map(e=>{let n=`[${e.timestamp}] ${e.type.toUpperCase()}: ${e.method} ${e.url}`;return e.data&&(e.data.status&&(n+=` - Status: ${e.data.status}`),e.data.confidence&&(n+=` - Confidence: ${(e.data.confidence*100).toFixed(1)}%`),e.data.message&&(n+=` - ${e.data.message}`),e.data.result&&(n+=`
Result: ${JSON.stringify(e.data.result,null,2)}`)),n}).join(`

`);navigator.clipboard.writeText(t).then(()=>{r("Console copied to clipboard","info")}).catch(()=>{r("Failed to copy to clipboard","error")})}window.captureCard=te;window.handleFileSelect=G;window.clearImagePreview=ee;window.copyConsoleToClipboard=ne;window.toggleConsolePause=Q;document.addEventListener("DOMContentLoaded",()=>{const t=document.getElementById("pauseConsoleBtn");t&&(t.textContent=u?"Resume Console":"Pause Console")});setTimeout(()=>{y.isConnected()&&g()},1e3);
