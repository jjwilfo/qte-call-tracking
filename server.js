// =======================================
// QTE Call Tracking Backend
// =======================================

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const cron = require("cron");

// ------------------------
// 1. EXPRESS SETUP
// ------------------------
const app = express();
app.use(cors());
app.use(express.json());

// ------------------------
// 2. DATABASE SETUP (Railway variables later)
// ------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ------------------------
// 3. CREATE TABLES ON START
// ------------------------
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_clicks (
      id UUID PRIMARY KEY,
      timestamp TIMESTAMP,
      affiliate_id TEXT,
      destination_number TEXT,
      page_url TEXT,
      matched BOOLEAN DEFAULT false,
      caller_number TEXT,
      call_start TIMESTAMP,
      call_duration INT
    );
  `);

  console.log("Database ready ✔");
}
initDB();

// ------------------------
// 4. API ENDPOINT — RECEIVE CALL CLICKS
// ------------------------
app.post("/api/call-click", async (req, res) => {
  try {
    const { callClickId, affiliateId, timestamp, destinationNumber, pageUrl } = req.body;

    await pool.query(
      `INSERT INTO call_clicks (id, timestamp, affiliate_id, destination_number, page_url)
       VALUES ($1, $2, $3, $4, $5)
      `,
      [callClickId, timestamp, affiliateId, destinationNumber, pageUrl]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error saving call click:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------
// 5. PBXACT: GET CDR LOGS
// ------------------------
async function getPBXCalls(fromTime, toTime, destinationNumber) {
  try {
    const response = await axios.get(process.env.PBX_CDR_URL, {
      params: {
        dst: destinationNumber,
        date_from: fromTime,
        date_to: toTime
      },
      auth: {
        username: process.env.PBX_USER,
        password: process.env.PBX_PASS
      }
    });

    return response.data.records || [];
  } catch (err) {
    console.error("PBX CDR ERROR:", err);
    return [];
  }
}

// ------------------------
// 6. LeadDyno Create Lead
// ------------------------
async function createLeadDynoLead(phone, affiliateId, meta) {
  try {
    await axios.post("https://api.leaddyno.com/v1/lead/create", {
      phone,
      affiliate_id: affiliateId || undefined,
      source: "Website Call Button",
      meta
    }, {
      headers: { "Authorization": `Bearer ${process.env.LEADDYNO_API_KEY}` }
    });

    console.log("LeadDyno lead created ✔");
  } catch (err) {
    console.error("LeadDyno ERROR:", err.response?.data || err);
  }
}

// ------------------------
// 7. CRON — MATCH CALLS EVERY MINUTE
// ------------------------
new cron.CronJob("*/1 * * * *", async () => {
  console.log("Cron: checking for unmatched call clicks…");

  const clicks = await pool.query(`
    SELECT * FROM call_clicks
    WHERE matched = false
    ORDER BY timestamp DESC
  `);

  for (let row of clicks.rows) {
    const startWindow = new Date(row.timestamp - 30 * 1000).toISOString();
    const endWindow = new Date(row.timestamp.getTime() + 10 * 60 * 1000).toISOString();

    const calls = await getPBXCalls(startWindow, endWindow, row.destination_number);

    if (calls.length > 0) {
      const call = calls[0];

      await pool.query(`
        UPDATE call_clicks
        SET matched = true,
            caller_number = $1,
            call_start = $2,
            call_duration = $3
        WHERE id = $4
      `, [call.src, call.start, call.duration, row.id]);

      await createLeadDynoLead(call.src, row.affiliate_id, {
        callClickId: row.id,
        pageUrl: row.page_url,
        timestamp_clicked: row.timestamp,
        timestamp_call_received: call.start,
        duration: call.duration
      });

      console.log(`Matched call for click ${row.id}`);
    }
  }
}, null, true);

// ------------------------
// 8. START SERVER
// ------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Backend running on port ${port}`));
