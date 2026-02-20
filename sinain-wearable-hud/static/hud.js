(function () {
    "use strict";

    const contentEl = document.getElementById("content");
    const dotEl = document.getElementById("status-dot");
    let ws = null;
    let reconnectDelay = 1000;

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
        contentEl.textContent = state.text || "";
        contentEl.className = state.priority || "normal";
        dotEl.className = state.status || "idle";
    }

    // Prevent screen sleep on mobile/tablet debug viewers
    async function requestWakeLock() {
        try {
            if ("wakeLock" in navigator) {
                await navigator.wakeLock.request("screen");
            }
        } catch (e) {
            // WakeLock not supported or denied — fine
        }
    }

    requestWakeLock();
    connect();
})();
