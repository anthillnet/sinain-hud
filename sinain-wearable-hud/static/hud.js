(function () {
    "use strict";

    const obsLog = document.getElementById("observation-log");
    const visionLog = document.getElementById("vision-log");
    const responseLog = document.getElementById("response-log");
    const oledEl = document.getElementById("oled-mirror");
    const dotEl = document.getElementById("status-dot");
    const gwBadge = document.getElementById("gateway-status");
    const ocrLatencyEl = document.getElementById("ocr-latency");
    const debugInfoEl = document.getElementById("debug-info");
    const timestampEl = document.getElementById("timestamp");
    const obsCountEl = document.getElementById("obs-count");
    const visionCountEl = document.getElementById("vision-count");
    const responseCountEl = document.getElementById("response-count");

    let ws = null;
    let reconnectDelay = 1000;
    let messageCount = 0;

    // Track previous values to detect changes
    let prevObservation = "";
    let prevVision = "";
    let prevResponse = "";

    // Log entry counts
    let obsEntries = 0;
    let visionEntries = 0;
    let responseEntries = 0;

    const MAX_LOG_ENTRIES = 200;

    function timeStr() {
        const d = new Date();
        return d.toLocaleTimeString("en-GB", { hour12: false });
    }

    function appendLog(container, text, countEl, countRef) {
        const entry = document.createElement("div");
        entry.className = "log-entry";

        const ts = document.createElement("span");
        ts.className = "log-ts";
        ts.textContent = timeStr();

        const body = document.createElement("pre");
        body.className = "log-body";
        body.textContent = text;

        entry.appendChild(ts);
        entry.appendChild(body);
        container.appendChild(entry);

        // Trim old entries
        while (container.children.length > MAX_LOG_ENTRIES) {
            container.removeChild(container.firstChild);
        }

        // Auto-scroll if near bottom
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
        if (isNearBottom) {
            container.scrollTop = container.scrollHeight;
        }

        return countRef + 1;
    }

    function connect() {
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${proto}//${location.host}/ws`);

        ws.onopen = function () {
            reconnectDelay = 1000;
            dotEl.className = "connected";
        };

        ws.onmessage = function (evt) {
            try {
                const state = JSON.parse(evt.data);
                messageCount++;
                render(state);
            } catch (e) {
                console.error("Bad message:", e);
            }
        };

        ws.onclose = function () {
            dotEl.className = "error";
            setTimeout(connect, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 10000);
        };

        ws.onerror = function () {
            ws.close();
        };
    }

    function render(state) {
        // Status indicators
        dotEl.className = state.status || "idle";
        gwBadge.textContent = state.gateway_status || "disconnected";
        gwBadge.className = "badge " + (state.gateway_status || "disconnected");

        // Panel 1: Observation sent to agent — log on change
        if (state.observation_sent && state.observation_sent !== prevObservation) {
            prevObservation = state.observation_sent;
            obsEntries = appendLog(obsLog, state.observation_sent, obsCountEl, obsEntries);
            obsCountEl.textContent = obsEntries;
        }

        // Panel 2: Vision — scene description + OCR text — log on change
        {
            let content = "";
            if (state.scene_description) {
                content += "── Scene ──\n" + state.scene_description;
            }
            if (state.ocr_text) {
                if (content) content += "\n\n";
                content += "── Text ──\n" + state.ocr_text;
            }
            if (content && content !== prevVision) {
                prevVision = content;
                visionEntries = appendLog(visionLog, content, visionCountEl, visionEntries);
                visionCountEl.textContent = visionEntries;
            }
        }
        if (state.last_ocr_ms > 0) {
            ocrLatencyEl.textContent = `(${(state.last_ocr_ms / 1000).toFixed(1)}s)`;
        }

        // Panel 3: Agent response — log on change
        if (state.response_text && state.response_text !== prevResponse) {
            prevResponse = state.response_text;
            responseEntries = appendLog(responseLog, state.response_text, responseCountEl, responseEntries);
            responseCountEl.textContent = responseEntries;
        }

        // OLED mirror shows the actual text being displayed on the 128x128 OLED
        oledEl.textContent = state.text || "";
        oledEl.className = "";
        if (state.priority === "urgent") {
            oledEl.style.color = "#ff3333";
        } else if (state.priority === "high") {
            oledEl.style.color = "#aaaaaa";
        } else {
            oledEl.style.color = "#00ff88";
        }

        // Footer info
        debugInfoEl.textContent = state.debug_text || "";
        if (state.last_update) {
            const d = new Date(state.last_update * 1000);
            timestampEl.textContent = d.toLocaleTimeString() + " | msgs: " + messageCount;
        }
    }

    // Prevent screen sleep on mobile/tablet debug viewers
    async function requestWakeLock() {
        try {
            if ("wakeLock" in navigator) {
                await navigator.wakeLock.request("screen");
            }
        } catch (e) {
            // WakeLock not supported or denied
        }
    }

    requestWakeLock();
    connect();
})();
