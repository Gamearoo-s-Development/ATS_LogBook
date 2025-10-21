// public/main.js — UI logic for posting duty events and polling telemetry

// Utility: POST JSON and parse response
async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",                      // POST method
        headers: { "Content-Type": "application/json" }, // Tell server it's JSON
        body: JSON.stringify(body)           // Serialize body
    });
    return res.json();                     // Parse JSON response
}

// When a status button is clicked, send /api/event with chosen status
document.querySelectorAll(".status-buttons .status")?.forEach(btn => {
    btn.addEventListener("click", async () => {
        const status = btn.getAttribute("data-status");  // OFF/SB/D/ON/YM/PC
        const noteEl = document.getElementById("note");  // Optional note input
        const note = noteEl ? noteEl.value.trim() : ""; // Note text if any

        // Disable buttons to avoid double submits
        document.querySelectorAll(".status-buttons .status").forEach(b => b.disabled = true);

        try {
            const result = await postJson("/api/event", { status, note }); // Call server API
            const out = document.getElementById("post-result");            // Feedback area
            if (result.ok) {
                out.textContent = `Saved ${status} at game time ${result.event.gameTimeIso.slice(11, 16)} (odometer: ${typeof result.event.odometerMi === "number" ? result.event.odometerMi.toFixed(0) + " mi" : "—"
                    }). Refreshing…`;
                // Refresh page to show new segment/event
                window.location.reload();
            } else {
                out.textContent = "Error: " + (result.error || "Unknown error");
            }
        } catch (e) {
            document.getElementById("post-result").textContent = "Network error posting event.";
        } finally {
            document.querySelectorAll(".status-buttons .status").forEach(b => b.disabled = false);
        }
    });
});

// Optional: light telemetry polling to keep the Game Time card fresh
// NOTE: We DO NOT extrapolate IRL time; we simply re-read telemetry.game.time.
async function pollTelemetry() {
    try {
        const res = await fetch("/api/telemetry");   // Ask our backend proxy for latest
        const json = await res.json();
        if (json && json.ok && json.telemetry && json.telemetry.game && json.telemetry.game.time) {
            const iso = json.telemetry.game.time;      // Absolute game time (ISO)
            const date = iso.slice(0, 10);             // YYYY-MM-DD
            const time = iso.slice(11, 16);            // HH:mm
            const wrap = document.getElementById("game-time");
            if (wrap) {
                // Re-render the two lines (Date/Time) in the Game Time card
                wrap.innerHTML = `
          <div class="card-kv"><span>Date:</span><span>${date}</span></div>
          <div class="card-kv"><span>Time:</span><span>${time}</span></div>
        `;
            }
        }
    } catch {
        // ignore — page still works on last known data
    }
}

// Poll every 2 seconds (lightweight, and only reading telemetry)
setInterval(pollTelemetry, 2000);
