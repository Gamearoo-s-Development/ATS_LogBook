// public/main.js — UI logic for posting duty events + connection/paused status + date picker + auto City, State

async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    return res.json();
}

// Status button posting (activity + location, no note)
document.querySelectorAll(".status-buttons .status")?.forEach(btn => {
    btn.addEventListener("click", async () => {
        const status = btn.getAttribute("data-status");
        const activity = (document.getElementById("activity")?.value || "").trim();
        const location = (document.getElementById("location")?.value || "").trim();

        document.querySelectorAll(".status-buttons .status").forEach(b => b.disabled = true);
        try {
            const result = await postJson("/api/event", { status, activity, location });
            const out = document.getElementById("post-result");
            if (result.ok) {
                out.textContent = `Saved ${status} at game time ${fmt12(result.event.gameTimeIso)}. Refreshing…`;
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

// Date picker → navigate to /log/YYYY-MM-DD
const datePicker = document.getElementById("date-picker");
if (datePicker) {
    datePicker.addEventListener("change", (e) => {
        const v = e.target.value;
        if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
            window.location.href = `/log/${v}`;
        }
    });
}

// ISO → "h:mm AM/PM"
function fmt12(iso) {
    if (!iso || iso.length < 16) return "—";
    const hh = Number(iso.slice(11, 13));
    const mm = iso.slice(14, 16);
    const ampm = hh >= 12 ? "PM" : "AM";
    const h12 = ((hh % 12) || 12);
    return `${h12}:${mm} ${ampm}`;
}

// Guess "City, State" from telemetry payload (robust across APIs)
function guessCityState(payload) {
    const nav = payload?.navigation || {};
    const truckPlace = payload?.truck?.place || {};
    const job = payload?.job || {};

    const cityCandidates = [
        nav.city, nav.cityName, nav.currentCity, nav.destinationCity, nav.nextWaypointCity,
        truckPlace.city, job.destinationCity, job.sourceCity
    ];
    const stateCandidates = [
        nav.state, nav.stateCode, nav.region, nav.province, nav.countryCode,
        truckPlace.state, truckPlace.stateCode, truckPlace.countryCode
    ];

    const city = cityCandidates.find(v => typeof v === "string" && v.trim()) || "";
    const state = stateCandidates.find(v => typeof v === "string" && v.trim()) || "";
    if (city && state) return `${city}, ${state}`;
    if (city) return city;
    if (state) return state;
    return "";
}

// Live connected/paused UI and center alerts
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
        if (alertPaused) alertPaused.classList.add("hidden"); // unknown paused when disconnected
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

    // Auto-fill Location (City, State) if user hasn't typed yet
    const locInput = document.getElementById("location");
    if (locInput && !locInput.dataset.userEdited) {
        const guess = guessCityState(payload);
        if (guess && (!locInput.value || locInput.value.trim() === "")) {
            locInput.value = guess;
        }
    }
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

// Mark location as user-edited once they type
const locInput = document.getElementById("location");
if (locInput) {
    locInput.addEventListener("input", () => {
        locInput.dataset.userEdited = "true";
    });
}
