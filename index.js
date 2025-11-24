require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();

// -----------------------------
// CORS CONFIGURATION
// -----------------------------
app.use(cors({
    origin: "https://www.qualitytruckandequipment.com", // your website
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// TEMP STORAGE (replace with Supabase later)
let clickEvents = [];

/**
 * STEP 1 — Record call button clicks
 */
app.post("/api/call-click", (req, res) => {
    const { affiliateId, phoneNumber } = req.body;

    const clickEvent = {
        id: uuidv4(),
        affiliateId: affiliateId || null,
        phoneNumber,
        timestamp: Date.now(),
        matched: false
    };

    clickEvents.push(clickEvent);
    console.log("Saved Call Click:", clickEvent);

    return res.json({ success: true, clickId: clickEvent.id });
});

/**
 * STEP 2 — Check PBXact logs
 */
app.get("/api/check-calls", async (req, res) => {
    try {
        console.log("Checking PBXact logs...");

        const pbxResponse = await axios.get(
            `${process.env.PBXACT_API_URL}/call-logs`,
            {
                headers: { Authorization: `Bearer ${process.env.PBXACT_API_KEY}` }
            }
        );

        const pbxLogs = pbxResponse.data.logs;

        for (let event of clickEvents) {
            if (event.matched) continue;

            const match = pbxLogs.find(
                (log) =>
                    log.callerNumber === event.phoneNumber &&
                    log.timestamp >= event.timestamp
            );

            if (match) {
                console.log("Matched call:", match);
                event.matched = true;
                event.callTimestamp = match.timestamp;

                // Send lead to LeadDyno
                await axios.post(`${process.env.BACKEND_URL}/api/send-lead`, {
                    phoneNumber: event.phoneNumber,
                    affiliateId: event.affiliateId,
                    clickId: event.id,
                    timestamp: event.timestamp
                });
            }
        }

        return res.json({ success: true, message: "PBX logs checked" });
    } catch (error) {
        console.error("PBXACT Error:", error.message);
        return res.status(500).json({ success: false, error: "PBXact request failed" });
    }
});

/**
 * STEP 3 — Send lead to LeadDyno
 */
app.post("/api/send-lead", async (req, res) => {
    const { phoneNumber, affiliateId, clickId, timestamp } = req.body;

    try {
        const response = await axios.post(
            "https://api.leaddyno.com/v1/leads",
            {
                key: process.env.LEADDYNO_API_KEY,
                email: `${phoneNumber}@caller.com`,
                first_name: "Phone Lead",
                last_name: clickId,
                affiliate_id: affiliateId || "",
                custom: { phoneNumber, clickId, clickTimestamp: timestamp }
            }
        );

        console.log("LeadDyno Lead Sent:", response.data);
        res.json({ success: true, sent: true });
    } catch (error) {
        console.error("LeadDyno Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, error: "LeadDyno request failed" });
    }
});

/**
 * START SERVER
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});

