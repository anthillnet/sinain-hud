(function () {
    "use strict";

    const observationEl = document.getElementById("observation-text");
    const visionEl = document.getElementById("vision-text");
    const responseEl = document.getElementById("response-text");
    const oledEl = document.getElementById("oled-mirror");
    const dotEl = document.getElementById("status-dot");
    const gwBadge = document.getElementById("gateway-status");
    const ocrLatencyEl = document.getElementById("ocr-latency");
    const debugInfoEl = document.getElementById("debug-info");
    const timestampEl = document.getElementById("timestamp");

    let ws = null;
    let reconnectDelay = 1000;
    let messageCount = 0;

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

        // Panel 1: Observation sent to agent
        if (state.observation_sent) {
            observationEl.textContent = state.observation_sent;
            // Auto-scroll to bottom
            observationEl.scrollTop = observationEl.scrollHeight;
        }

        // Panel 2: Vision — scene description + OCR text
        {
            let content = "";
            if (state.scene_description) {
                content += "── Scene ──\n" + state.scene_description;
            }
            if (state.ocr_text) {
                if (content) content += "\n\n";
                content += "── Text ──\n" + state.ocr_text;
            }
            if (content) {
                visionEl.textContent = content;
            }
        }
        if (state.last_ocr_ms > 0) {
            ocrLatencyEl.textContent = `(${(state.last_ocr_ms / 1000).toFixed(1)}s)`;
        }

        // Panel 3: Agent response (+ OLED mirror)
        if (state.response_text) {
            responseEl.textContent = state.response_text;
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
