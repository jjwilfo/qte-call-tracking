require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(express.json());

// Allow your website domain AND the Railway domain
app.use(
    cors({
        origin: [
            "https://www.qualitytruckandequipment.com",
            "https://qte-call-tracking-production.up.railway.app"
        ],
        methods: ["GET", "POST"],
        allowedHeaders: ["Content-Type"]
    })
);

// TEMP MEMORY (later replaced with Supabase)
let clickEvents = [];

/* --------------------------------------------------
   STEP 1 — Save click event from the website
-------------------------------------------------- */
app.post("/api/call-click", (req, res) => {
    const { affiliateId, phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ success: false, error: "Missing phoneNumber" });
    }

    const cleanNumber = phoneNumber.replace(/\D/g, ""); // Strip symbols

    const clickEvent = {
        id: uuidv4(),
        affiliateId: affiliateId || null,
        clickedNumber: cleanNumber, // phone line clicked
        timestamp: Date.now(),
        matched: false
    };

    clickEvents.push(clickEvent);

    console.log("Saved Call Click:", clickEvent);

    return res.json({
        success: true,
        clickId: clickEvent.id
    });
});

/* --------------------------------------------------
   STEP 2 — PBX CALL MATCHING (token-based)
-------------------------------------------------- */
async function getPBXToken() {
    try {
        const res = await axios.post(
            process.env.PBXACT_TOKEN_URL,
            {
                username: process.env.PBX_USERNAME,
                password: process.env.PBX_PASSWORD
            },
            { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
        );

        return res.data?.token || null;
    } catch (err) {
        console.error("Error fetching PBX token:", err.message);
        return null;
    }
}

async function fetchPBXLogs(token) {
    try {
        const res = await axios.get(`${process.env.PBXACT_API_URL}/call-logs`, {
            headers: { Authorization: `Bearer ${token}` },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });
        return res.data.logs || [];
    } catch (err) {
        console.error("Error fetching PBX logs:", err.message);
        return [];
    }
}

async function checkPBXCalls() {
    try {
        console.log("Checking PBX logs...");

        const token = await getPBXToken();
        if (!token) {
            console.error("No PBX token available. Skipping check.");
            return;
        }

        const pbxLogs = await fetchPBXLogs(token);

        for (let event of clickEvents) {
            if (event.matched) continue;

            const match = pbxLogs.find(log => {
                const pbxCalled = log.calledNumber?.replace(/\D/g, "");
                return pbxCalled === event.clickedNumber && log.timestamp >= event.timestamp;
            });

            if (match) {
                console.log("Matched call:", match);

                event.matched = true;
                event.callTimestamp = match.timestamp;
                event.callerNumber = match.callerNumber;

                // Auto-send lead to LeadDyno
                await axios.post(`${process.env.BACKEND_URL}/api/send-lead`, {
                    phoneNumber: event.callerNumber,
                    affiliateId: event.affiliateId,
                    clickId: event.id,
                    timestamp: event.timestamp
                });
            }
        }
    } catch (err) {
        console.error("PBX Error:", err.message);
    }
}

// Expose endpoint for manual triggering
app.get("/api/check-calls", async (req, res) => {
    await checkPBXCalls();
    res.json({ success: true, message: "PBX logs checked" });
});

/* --------------------------------------------------
   STEP 3 — SEND TO LEADDYNO
-------------------------------------------------- */
app.post("/api/send-lead", async (req, res) => {
    const { phoneNumber, affiliateId, clickId, timestamp } = req.body;

    try {
        const leaddynoRes = await axios.post(
            "https://api.leaddyno.com/v1/leads",
            {
                key: process.env.LEADDYNO_API_KEY,
                email: `${phoneNumber}@caller.com`,
                first_name: "Phone Lead",
                last_name: clickId,
                affiliate_id: affiliateId || "",
                custom: {
                    callerPhone: phoneNumber,
                    clickId,
                    clickTimestamp: timestamp
                }
            }
        );

        console.log("LeadDyno Lead Sent:", leaddynoRes.data);

        return res.json({ success: true, sent: true });
    } catch (error) {
        console.error("LeadDyno Error:", error.response?.data || error.message);

        return res.status(500).json({
            success: false,
            error: "LeadDyno request failed"
        });
    }
});

/* --------------------------------------------------
   START SERVER
-------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Backend running on port ${PORT}`);

    // Run PBX check immediately on startup
    await checkPBXCalls();

    // Optional: run every 5 minutes
    setInterval(checkPBXCalls, 5 * 60 * 1000);
});




