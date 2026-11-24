let datasetStore = [];
const MAX_RECORDS = 5000;

const CSV_HEADER =
  "timestamp,lux,temp_c,pv_v,pv_i,pv_p,mppt_v,mppt_i,mppt_p,batt_v,batt_i,batt_p,load_v,load_i,load_p";

module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    const filterDate = req.query && req.query.date ? String(req.query.date).trim() : null;
    const filtered = filterDate
      ? datasetStore.filter((d) => typeof d.ts === "string" && d.ts.startsWith(filterDate))
      : datasetStore;

    if (req.query && req.query.format === "csv") {
      const rows = filtered.map(
        (d) =>
          `${d.ts},${d.lux},${d.temp},${d.pv.v},${d.pv.i},${d.pv.p},${d.mppt.v},${d.mppt.i},${d.mppt.p},${d.batt.v},${d.batt.i},${d.batt.p},${d.load.v},${d.load.i},${d.load.p}`
      );
      const csv = [CSV_HEADER, ...rows].join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="barokah_jaya_plts_${filterDate || Date.now()}.csv"`
      );
      return res.status(200).send(csv);
    }

    return res.status(200).json({
      project: "Barokah Jaya Workspace",
      date: filterDate || "all",
      count: filtered.length,
      data: filterDate ? filtered : filtered.slice(-500),
    });
  }

  if (req.method === "POST") {
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!body || typeof body.lux !== "number" || !body.pv || !body.mppt || !body.batt || !body.load) {
        return res.status(400).json({ error: "Struktur payload sensor tidak valid" });
      }

      datasetStore.push(body);
      if (datasetStore.length > MAX_RECORDS) {
        datasetStore.shift();
      }

      return res.status(200).json({ ok: true, count: datasetStore.length });
    } catch {
      return res.status(500).json({ error: "Gagal memproses JSON" });
    }
  }

  if (req.method === "DELETE") {
    datasetStore = [];
    return res.status(200).json({ ok: true, count: 0 });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
