// public/main.js — UI logic for posting duty events and live connection/paused status

async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    return res.json();
}

document.querySelectorAll(".status-buttons .status")?.forEach(btn => {
    btn.addEventListener("click", async () => {
        const status = btn.getAttribute("data-status");
        const note = (document.getElementById("note")?.value || "").trim();
        document.querySelectorAll(".status-buttons .status").forEach(b => b.disabled = true);
        try {
            const result = await postJson("/api/event", { status, note });
            const out = document.getElementById("post-result");
            if (result.ok) {
                out.textContent = `Saved ${status} at game time ${result.event.gameTimeIso.slice(11, 16)}. Refreshing…`;
                window.location.reload();
            } else {
                out.textContent = "Error: " + (result.error || "Unknown error");
            }
        } catch {
            const out = document.getElementById("post-result");
            if (out) out.textContent = "Network error posting event.";
        } finally {
            document.querySelectorAll(".status-buttons .status").forEach(b => b.disabled = false);
        }
    });
});

// ISO → "h:mm AM/PM"
function fmt12(iso) {
    if (!iso || iso.length < 16) return "—";
    const hh = Number(iso.slice(11, 13));
    const mm = iso.slice(14, 16);
    const ampm = hh >= 12 ? "PM" : "AM";
    const h12 = ((hh % 12) || 12);
    return `${h12}:${mm} ${ampm}`;
}

function setConnectionUI(connected, paused, payload) {
    const connEl = document.getElementById("telemetry-connected");
    const alertConn = document.getElementById("conn-alert");
    const alertPaused = document.getElementById("paused-alert");

    const gameEl = document.getElementById("telemetry-game");
    const pausedEl = document.getElementById("telemetry-paused");
    const scaleEl = document.getElementById("telemetry-timescale");
    const dateEl = document.getElementById("game-date");
    const timeEl = document.getElementById("game-time-text");

    // Connected label
    if (connEl) {
        connEl.textContent = connected ? "Yes" : "No";
        connEl.classList.toggle("kv-value-ok", connected);
        connEl.classList.toggle("kv-value-bad", !connected);
    }

    // Center alerts
    if (!connected) {
        if (alertConn) alertConn.classList.remove("hidden");
        if (alertPaused) alertPaused.classList.add("hidden"); // paused state unknown when disconnected
        // Blank info
        if (gameEl) gameEl.textContent = "—";
        if (pausedEl) pausedEl.textContent = "—";
        if (scaleEl) scaleEl.textContent = "—";
        if (dateEl) dateEl.textContent = "—";
        if (timeEl) timeEl.textContent = "—";
        return;
    } else {
        if (alertConn) alertConn.classList.add("hidden");
    }

    // Connected: show/hide paused alert & fill fields
    const t = payload?.game?.time || null;
    const pausedBool = (typeof paused === "boolean") ? paused : (typeof payload?.game?.paused === "boolean" ? payload.game.paused : null);

    if (alertPaused) {
        if (pausedBool === true) alertPaused.classList.remove("hidden");
        else alertPaused.classList.add("hidden");
    }

    if (gameEl) gameEl.textContent = payload?.game?.gameName ?? "—";
    if (pausedEl) pausedEl.textContent = (pausedBool === null) ? "—" : (pausedBool ? "Yes" : "No");
    if (scaleEl) scaleEl.textContent = (payload?.game?.timeScale ?? "—");
    if (dateEl) dateEl.textContent = t ? t.slice(0, 10) : "—";
    if (timeEl) timeEl.textContent = t ? fmt12(t) : "—";
}

// Poll the live endpoint every 1s
async function pollTelemetry() {
    try {
        const res = await fetch("/api/telemetry", { cache: "no-store" });
        const json = await res.json();
        setConnectionUI(Boolean(json?.connected), json?.paused ?? null, json?.telemetry || null);
    } catch {
        setConnectionUI(false, null, null);
    }
}
setInterval(pollTelemetry, 1000);
pollTelemetry();
