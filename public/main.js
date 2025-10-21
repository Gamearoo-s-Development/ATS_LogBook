// public/main.js — UI logic for posting duty events and polling telemetry

// Utility: POST JSON and parse response
async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    return res.json();
}

// When a status button is clicked, send /api/event with chosen status
document.querySelectorAll(".status-buttons .status")?.forEach(btn => {
    btn.addEventListener("click", async () => {
        const status = btn.getAttribute("data-status");
        const noteEl = document.getElementById("note");
        const note = noteEl ? noteEl.value.trim() : "";

        // Disable buttons to avoid double submits
        document.querySelectorAll(".status-buttons .status").forEach(b => b.disabled = true);

        try {
            const result = await postJson("/api/event", { status, note });
            const out = document.getElementById("post-result");
            if (result.ok) {
                out.textContent = `Saved ${status} at game time ${result.event.gameTimeIso.slice(11, 16)} (odometer: ${typeof result.event.odometerMi === "number" ? result.event.odometerMi.toFixed(0) + " mi" : "—"
                    }). Refreshing…`;
                window.location.reload();
            } else {
                out.textContent = "Error: " + (result.error || "Unknown error");
            }
        } catch (e) {
            const out = document.getElementById("post-result");
            if (out) out.textContent = "Network error posting event.";
        } finally {
            document.querySelectorAll(".status-buttons .status").forEach(b => b.disabled = false);
        }
    });
});

// Helper: format ISO "0001-01-08T21:09:00Z" → "h:mm AM/PM"
function fmt12(iso) {
    try {
        if (!iso || iso.length < 16) return "—";
        const hh = Number(iso.slice(11, 13));
        const mm = iso.slice(14, 16);
        const ampm = hh >= 12 ? "PM" : "AM";
        const h12 = ((hh % 12) || 12);
        return `${h12}:${mm} ${ampm}`;
    } catch {
        return "—";
    }
}

// Optional: light telemetry polling to keep the Game Time card fresh
// NOTE: We DO NOT extrapolate IRL time; we simply re-read telemetry.game.time.
async function pollTelemetry() {
    try {
        const res = await fetch("/api/telemetry");
        const json = await res.json();
        if (json && json.ok && json.telemetry && json.telemetry.game && json.telemetry.game.time) {
            const iso = json.telemetry.game.time;      // Absolute game time (ISO)
            const date = iso.slice(0, 10);             // YYYY-MM-DD
            const wrap = document.getElementById("game-time");
            if (wrap) {
                wrap.innerHTML = `
          <div class="card-kv"><span>Date:</span><span>${date}</span></div>
          <div class="card-kv"><span>Time:</span><span>${fmt12(iso)}</span></div>
        `;
            }
        }
    } catch {
        // ignore — page still works on last known data
    }
}

// Poll every 2 seconds (lightweight, and only reading telemetry)
setInterval(pollTelemetry, 2000);
