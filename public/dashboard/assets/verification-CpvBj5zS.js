var g=(o,t)=>()=>(t||o((t={exports:{}}).exports,t),t.exports);import"./banner-BpERPkmb.js";var f=g((C,s)=>{class l extends EventTarget{constructor(t="/api/telemetry/input.csv"){super(),this.sequenceCounter=0,this.cycleId=`cycle_${Date.now()}`,this.csvPath=t,this.startTime=Date.now(),console.log(`[InputBus] Initialized, cycle: ${this.cycleId}`)}emitInput(t){const e=++this.sequenceCounter,r={...t,seq:e,cycleId:t.cycleId||this.cycleId},c=["capture","approve","reject"],n=["keyboard","controller"];if(!c.includes(r.action)){console.error("Invalid action:",r.action);return}if(!n.includes(r.source)){console.error("Invalid source:",r.source);return}this.recordTelemetry(r),this.dispatchEvent(new CustomEvent("input",{detail:r})),this.dispatchEvent(new CustomEvent(r.action,{detail:r})),console.log(`[InputBus] Input: ${r.action} from ${r.source} [${r.seq}]`)}async recordTelemetry(t){const e={ts:t.ts,source:t.source,action:t.action,cardId:t.cardId||"",cycleId:t.cycleId||this.cycleId,latencyMs:Date.now()-t.ts,error:""};try{await fetch("/api/telemetry/input",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(e)})}catch(r){console.warn("Failed to record telemetry:",r),this.storeLocalTelemetry(e)}}storeLocalTelemetry(t){const e=`cardmint_telemetry_${this.cycleId}`,r=JSON.parse(localStorage.getItem(e)||"[]");r.push(t),localStorage.setItem(e,JSON.stringify(r))}onAction(t,e){this.addEventListener(t,r=>e(r.detail))}onInput(t){this.addEventListener("input",e=>t(e.detail))}async getTelemetrySummary(){try{return await(await fetch(`/api/telemetry/input/summary?cycle=${this.cycleId}`)).json()}catch(t){return console.error("Failed to get telemetry summary:",t),this.getLocalTelemetrySummary()}}getLocalTelemetrySummary(){const t=`cardmint_telemetry_${this.cycleId}`,e=JSON.parse(localStorage.getItem(t)||"[]"),r=e.filter(a=>a.source==="keyboard").length,c=e.filter(a=>a.source==="controller").length,n=e.length,y=n>0?e.reduce((a,m)=>a+m.latencyMs,0)/n:0,d=Date.now()-this.startTime,w=n>0?n/d*6e4:0;return{totalInputs:n,keyboardInputs:r,controllerInputs:c,avgLatencyMs:y,sessionDurationMs:d,throughputPerMinute:w}}startNewCycle(){return this.cycleId=`cycle_${Date.now()}`,this.startTime=Date.now(),this.sequenceCounter=0,console.log(`[InputBus] Started new test cycle: ${this.cycleId}`),this.cycleId}getCurrentCycle(){return this.cycleId}}class p{constructor(t){this.bus=t,this.keyMappings={Space:"capture",KeyX:"capture",KeyA:"approve",KeyB:"reject",KeyR:"reject"},this.setupEventListeners(),console.log("[KeyboardAdapter] Initialized with minimal mappings")}setupEventListeners(){document.addEventListener("keydown",this.handleKeydown.bind(this))}handleKeydown(t){if(t.target.tagName==="INPUT"||t.target.tagName==="TEXTAREA")return;const e=document.activeElement;if(e&&(e.tagName==="BUTTON"||e.tagName==="A"||e.getAttribute("role")==="button")&&t.code==="Space"||t.repeat)return;t.preventDefault(),t.stopPropagation();const r=this.keyMappings[t.code];r&&this.bus.emitInput({action:r,source:"keyboard",ts:Date.now()})}getMappings(){return{"Space/X":"Capture Card",A:"Approve Card","B/R":"Reject Card"}}}class h{constructor(t){this.bus=t,this.connected=!1,console.log("[ControllerAdapter] Initialized (shim mode)")}simulateInput(t){this.bus.emitInput({action:t,source:"controller",ts:Date.now()})}isConnected(){return this.connected}getStatus(){return{connected:this.connected}}}window.inputBus=new l;window.KeyboardAdapter=p;window.ControllerAdapter=h;typeof s<"u"&&s.exports&&(s.exports={BrowserInputBus:l,BrowserKeyboardAdapter:p,BrowserControllerAdapter:h});class u{constructor(){this.inputBus=null,this.keyboardAdapter=null,this.controllerAdapter=null,this.currentInputSource="keyboard",this.telemetryEnabled=!0,this.captureDebounceMs=150,this._lastCaptureAt=0,this.initializeInputBus(),this.createStatusWidget()}async initializeInputBus(){try{if(window.inputBus&&window.KeyboardAdapter&&window.ControllerAdapter)this.inputBus=window.inputBus,this.keyboardAdapter=new window.KeyboardAdapter(this.inputBus),this.controllerAdapter=new window.ControllerAdapter(this.inputBus),console.log("[Dashboard] Input bus initialized"),this.setupInputHandlers(),this.updateStatusWidget();else throw new Error("Browser input bus not available")}catch(t){console.error("[Dashboard] Failed to initialize input bus:",t),this.setupFallbackKeyboardHandlers()}}setupInputHandlers(){this.inputBus&&(this.inputBus.onInput(t=>{this.handleInputEvent(t)}),this.inputBus.onAction("capture",t=>{this.handleCaptureAction(t)}),this.inputBus.onAction("approve",t=>{this.handleApproveAction(t)}),this.inputBus.onAction("reject",t=>{this.handleRejectAction(t)}))}handleInputEvent(t){this.currentInputSource=t.source,this.updateStatusWidget(),this.showInputFeedback(t.action,t.source),console.log(`[Dashboard] Input: ${t.action} from ${t.source}`)}async handleCaptureAction(t){try{const e=Date.now();if(e-this._lastCaptureAt<this.captureDebounceMs)return;if(this._lastCaptureAt=e,typeof window.captureCard=="function")await window.captureCard();else if(typeof window.triggerCapture=="function")await window.triggerCapture();else{const r=document.getElementById("capture-btn");r&&r.click()}this.showNotification("📸 Capture triggered","info")}catch(e){console.error("Capture action failed:",e),this.showNotification("Capture failed","error")}}async handleApproveAction(t){var e;try{if(!((e=window.queueItems)==null?void 0:e[window.currentQueueIndex])){this.showNotification("No card selected to approve","warning");return}typeof window.approveCard=="function"&&(await window.approveCard(),this.showNotification(`✅ Card approved via ${t.source}`,"success"))}catch(r){console.error("Approve action failed:",r),this.showNotification("Approve failed","error")}}async handleRejectAction(t){var e;try{if(!((e=window.queueItems)==null?void 0:e[window.currentQueueIndex])){this.showNotification("No card selected to reject","warning");return}typeof window.rejectCard=="function"&&(await window.rejectCard(),this.showNotification(`❌ Card rejected via ${t.source}`,"warning"))}catch(r){console.error("Reject action failed:",r),this.showNotification("Reject failed","error")}}createStatusWidget(){const t=document.createElement("div");t.id="input-status-widget",t.className="input-status-widget",t.innerHTML=`
      <div class="input-source">
        <span class="input-icon">⌨️</span>
        <span class="input-label">Keyboard</span>
      </div>
      <div class="input-mappings">
        <span class="mapping">Space/X = Capture</span>
        <span class="mapping">A = Approve</span>
        <span class="mapping">B/R = Reject</span>
      </div>
    `;const e=document.createElement("style");e.textContent=`
      .input-status-widget {
        position: fixed;
        top: 20px;
        right: 20px;
        background: rgba(0, 0, 0, 0.9);
        color: white;
        padding: 12px 16px;
        border-radius: 8px;
        font-size: 0.85rem;
        z-index: 1500;
        border: 2px solid #4a5568;
        min-width: 200px;
      }
      
      .input-source {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        font-weight: 600;
      }
      
      .input-icon {
        font-size: 1rem;
      }
      
      .input-mappings {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      
      .mapping {
        font-size: 0.75rem;
        color: #a0aec0;
      }
      
      .source-controller {
        border-color: #3182ce;
        background: rgba(49, 130, 206, 0.1);
      }
      
      .source-keyboard {
        border-color: #38a169;
        background: rgba(56, 161, 105, 0.1);
      }
      
      .input-feedback {
        position: fixed;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.9);
        color: white;
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 0.9rem;
        z-index: 2000;
        animation: inputPulse 0.6s ease-out;
      }
      
      @keyframes inputPulse {
        0% { transform: translateX(-50%) scale(0.8); opacity: 0; }
        50% { transform: translateX(-50%) scale(1.1); opacity: 1; }
        100% { transform: translateX(-50%) scale(1); opacity: 0; }
      }
    `,document.head.appendChild(e),document.body.appendChild(t),this.statusWidget=t}updateStatusWidget(){if(!this.statusWidget)return;const t=this.statusWidget.querySelector(".input-source"),e=t.querySelector(".input-icon"),r=t.querySelector(".input-label");this.currentInputSource==="controller"?(e.textContent="🎮",r.textContent="Controller",this.statusWidget.className="input-status-widget source-controller"):(e.textContent="⌨️",r.textContent="Keyboard",this.statusWidget.className="input-status-widget source-keyboard")}showInputFeedback(t,e){const r=document.createElement("div");r.className="input-feedback",r.textContent=`${t.toUpperCase()} (${e})`,document.body.appendChild(r),setTimeout(()=>{r.remove()},600)}showNotification(t,e="info"){typeof window.showNotification=="function"?window.showNotification(t,e):console.log(`[${e.toUpperCase()}] ${t}`)}setupFallbackKeyboardHandlers(){document.addEventListener("keydown",t=>{if(!(t.target.tagName==="INPUT"||t.target.tagName==="TEXTAREA"))switch(t.code){case"Space":case"KeyX":t.preventDefault(),this.handleCaptureAction({source:"keyboard"});break;case"KeyA":t.preventDefault(),this.handleApproveAction({source:"keyboard"});break;case"KeyB":case"KeyR":t.preventDefault(),this.handleRejectAction({source:"keyboard"});break}}),console.log("[Dashboard] Using fallback keyboard handlers")}getTelemetryData(){return this.inputBus?this.inputBus.getTelemetrySummary():null}startNewCycle(){if(this.inputBus){const t=this.inputBus.startNewCycle();return this.showNotification(`Started new test cycle: ${t}`,"info"),t}return null}}let i=null;document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>{i=new u,window.dashboardInputManager=i}):(i=new u,window.dashboardInputManager=i);window.DashboardInputManager=u});export default f();
