require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

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
   STEP 2 — PBX CALL MATCHING
   (Supabase cron or browser can call this)
-------------------------------------------------- */
app.get("/api/check-calls", async (req, res) => {
    try {
        console.log("Checking PBX logs...");

        const pbxResponse = await axios.get(
            `${process.env.PBXACT_API_URL}/call-logs`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.PBXACT_API_KEY}`
                },
                // PBX ACT often uses HTTPS with invalid certs
                httpsAgent: new (require("https").Agent)({
                    rejectUnauthorized: false
                })
            }
        );

        const pbxLogs = pbxResponse.data.logs;

        for (let event of clickEvents) {
            if (event.matched) continue;

            // Find PBX log where the "calledNumber" matches the clicked number
            const match = pbxLogs.find((log) => {
                const pbxCalled = log.calledNumber?.replace(/\D/g, "");
                return (
                    pbxCalled === event.clickedNumber &&
                    log.timestamp >= event.timestamp
                );
            });

            if (match) {
                console.log("Matched call:", match);

                event.matched = true;
                event.callTimestamp = match.timestamp;
                event.callerNumber = match.callerNumber; // REAL CALLER ID

                // Send lead to LeadDyno automatically
                await axios.post(
                    `${process.env.BACKEND_URL}/api/send-lead`,
                    {
                        phoneNumber: event.callerNumber,
                        affiliateId: event.affiliateId,
                        clickId: event.id,
                        timestamp: event.timestamp
                    }
                );
            }
        }

        return res.json({
            success: true,
            message: "PBX logs checked"
        });
    } catch (error) {
        console.error("PBX Error:", error.response?.data || error.message);
        return res.status(500).json({
            success: false,
            error: "PBXact request failed"
        });
    }
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
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});


