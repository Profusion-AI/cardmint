var l=Object.defineProperty;var d=(o,e,t)=>e in o?l(o,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):o[e]=t;var s=(o,e,t)=>d(o,typeof e!="symbol"?e+"":e,t);class r{constructor(){s(this,"el",null);s(this,"hideTimer",null)}ensureStyles(){if(document.getElementById("cm-reload-toast-style"))return;const e=document.createElement("style");e.id="cm-reload-toast-style",e.textContent=`
      .cm-reload-toast {
        position: fixed;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(20,20,20,0.92);
        color: #fff;
        padding: 10px 14px;
        border-radius: 12px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.25);
        font: 500 14px/1.1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 8px;
        pointer-events: none;
        opacity: 0;
        transition: opacity 140ms ease;
      }
      .cm-reload-toast.show { opacity: 1; }
      .cm-reload-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #ffcc00;
        box-shadow: 0 0 0 0 rgba(255,204,0,0.7);
        animation: cm-pulse 1.2s infinite;
      }
      @keyframes cm-pulse {
        0% { box-shadow: 0 0 0 0 rgba(255,204,0,0.7); }
        70% { box-shadow: 0 0 0 8px rgba(255,204,0,0); }
        100% { box-shadow: 0 0 0 0 rgba(255,204,0,0); }
      }
    `,document.head.appendChild(e)}show(e="Server reloaded… reconnecting"){this.ensureStyles(),this.el||(this.el=document.createElement("div"),this.el.className="cm-reload-toast",this.el.innerHTML='<span class="cm-reload-dot"></span><span class="cm-reload-text"></span>',document.body.appendChild(this.el));const t=this.el.querySelector(".cm-reload-text");t.textContent=e,this.el.classList.add("show")}hide(e=600){this.el&&(this.hideTimer&&(window.clearTimeout(this.hideTimer),this.hideTimer=null),this.hideTimer=window.setTimeout(()=>{var t;(t=this.el)==null||t.classList.remove("show")},e))}}class h{constructor(e,t,a){s(this,"url");s(this,"protocols");s(this,"backoff");s(this,"ws",null);s(this,"manualClose",!1);s(this,"attempts",0);s(this,"toast");s(this,"onopen",null);s(this,"onmessage",null);s(this,"onclose",null);s(this,"onerror",null);this.url=e,this.protocols=t,this.backoff={baseMs:200,maxMs:2500,...a??{}},this.toast=new r,this.connect()}connect(){this.ws=this.protocols?new WebSocket(this.url,this.protocols):new WebSocket(this.url),this.ws.onopen=e=>{var t;this.attempts=0,this.toast.hide(),(t=this.onopen)==null||t.call(this,e)},this.ws.onmessage=e=>{var t;return(t=this.onmessage)==null?void 0:t.call(this,e)},this.ws.onerror=e=>{var t;return(t=this.onerror)==null?void 0:t.call(this,e)},this.ws.onclose=e=>{var t;(t=this.onclose)==null||t.call(this,e),!this.manualClose&&(this.toast.show(),this.scheduleReconnect())}}scheduleReconnect(){this.attempts++;const e=Math.random()*50,t=Math.min(this.backoff.baseMs*Math.pow(2,this.attempts-1)+e,this.backoff.maxMs);setTimeout(()=>this.connect(),t)}send(e){if(!this.ws||this.ws.readyState!==WebSocket.OPEN)throw new Error("socket not open");this.ws.send(e)}close(e,t){this.manualClose=!0,this.ws&&(this.ws.readyState===WebSocket.OPEN||this.ws.readyState===WebSocket.CONNECTING)&&this.ws.close(e,t)}get readyState(){var e;return((e=this.ws)==null?void 0:e.readyState)??WebSocket.CLOSED}addEventListener(e,t){e==="open"&&(this.onopen=t),e==="message"&&(this.onmessage=t),e==="close"&&(this.onclose=t),e==="error"&&(this.onerror=t)}}let n=null;n||(n={Toast:new r,ReconnectingWebSocket:h});const m=n.Toast,u=n.ReconnectingWebSocket;function i(){var o;if(!(location.hostname!=="localhost"&&location.hostname!=="127.0.0.1"))try{const e=((o=document.querySelector('meta[name="ws-url"]'))==null?void 0:o.content)||"ws://localhost:3001",t=new u(e);t.addEventListener("open",()=>{console.log("[Dashboard] WebSocket connected")}),t.addEventListener("close",()=>{console.log("[Dashboard] WebSocket disconnected - toast will handle reconnection")}),t.addEventListener("message",a=>{try{JSON.parse(a.data).type==="server-reloading"&&m.show("Server is reloading...")}catch{}})}catch(e){console.warn("[Dashboard] WebSocket initialization failed:",e)}}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",i):i();
