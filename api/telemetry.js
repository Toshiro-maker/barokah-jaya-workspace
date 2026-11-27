const CSV_HEADER =
  "timestamp,lux,temp_c,pv_v,pv_i,pv_p,mppt_v,mppt_i,mppt_p,batt_v,batt_i,batt_p,load_v,load_i,load_p";

function cleanEnvValue(val) {
  return String(val || "").trim().replace(/^["']|["']$/g, "");
}

function getSupabaseCfg() {
  const rawUrl = cleanEnvValue(process.env.SUPABASE_URL);
  const key = cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!rawUrl || !key) return { error: "Environment Variables SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY belum diatur di Vercel." };

  if (!/^https?:\/\//i.test(rawUrl)) {
    return { error: "SUPABASE_URL di Vercel tidak valid (harus diawali https://... bukan API key)." };
  }

  // Ambil origin murni (mencegah error PGRST125 jika SUPABASE_URL di Vercel terlanjur diisi .../rest/v1)
  let url = rawUrl.replace(/\/rest\/v1.*$/i, "").replace(/\/+$/, "");
  try {
    url = new URL(rawUrl).origin;
  } catch {}

  return { url, key };
}

function sbHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function buildDateRangeFilter(dateStr) {
  if (!dateStr || dateStr === "ALL" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return "";
  const start = encodeURIComponent(`${dateStr} 00:00:00`);
  const end = encodeURIComponent(`${dateStr} 23:59:59`);
  return `&ts=gte.${start}&ts=lte.${end}`;
}

function normalizeIncoming(d) {
  if (!d || typeof d.ts !== "string" || !d.pv || !d.mppt || !d.batt || !d.load) return null;
  const ts = d.ts.trim();
  if (!/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/.test(ts)) return null;
  return {
    ts,
    sd: Boolean(d.sd),
    lux: Number(Number(d.lux || 0).toFixed(1)),
    temp_c: Number(Number(d.temp ?? d.temp_c ?? 0).toFixed(2)),
    pv_v: Number(Number(d.pv.v || 0).toFixed(2)),
    pv_i: Number(Number(d.pv.i || 0).toFixed(3)),
    pv_p: Number(Number(d.pv.p || 0).toFixed(2)),
    mppt_v: Number(Number(d.mppt.v || 0).toFixed(2)),
    mppt_i: Number(Number(d.mppt.i || 0).toFixed(3)),
    mppt_p: Number(Number(d.mppt.p || 0).toFixed(2)),
    batt_v: Number(Number(d.batt.v || 0).toFixed(2)),
    batt_i: Number(Number(d.batt.i || 0).toFixed(3)),
    batt_p: Number(Number(d.batt.p || 0).toFixed(2)),
    load_v: Number(Number(d.load.v || 0).toFixed(2)),
    load_i: Number(Number(d.load.i || 0).toFixed(3)),
    load_p: Number(Number(d.load.p || 0).toFixed(2)),
  };
}

function dbRowToClient(r) {
  return {
    ts: r.ts,
    sd: Boolean(r.sd),
    lux: Number(r.lux || 0),
    temp: Number(r.temp_c || 0),
    pv: { v: Number(r.pv_v || 0), i: Number(r.pv_i || 0), p: Number(r.pv_p || 0) },
    mppt: { v: Number(r.mppt_v || 0), i: Number(r.mppt_i || 0), p: Number(r.mppt_p || 0) },
    batt: { v: Number(r.batt_v || 0), i: Number(r.batt_i || 0), p: Number(r.batt_p || 0) },
    load: { v: Number(r.load_v || 0), i: Number(r.load_i || 0), p: Number(r.load_p || 0) },
  };
}

function dbRowToCsv(r) {
  return [
    r.ts,
    Number(r.lux || 0).toFixed(1),
    Number(r.temp_c || 0).toFixed(2),
    Number(r.pv_v || 0).toFixed(2),
    Number(r.pv_i || 0).toFixed(3),
    Number(r.pv_p || 0).toFixed(2),
    Number(r.mppt_v || 0).toFixed(2),
    Number(r.mppt_i || 0).toFixed(3),
    Number(r.mppt_p || 0).toFixed(2),
    Number(r.batt_v || 0).toFixed(2),
    Number(r.batt_i || 0).toFixed(3),
    Number(r.batt_p || 0).toFixed(2),
    Number(r.load_v || 0).toFixed(2),
    Number(r.load_i || 0).toFixed(3),
    Number(r.load_p || 0).toFixed(2),
  ].join(",");
}

async function fetchExactCount(cfg, dateStr = "") {
  const filter = buildDateRangeFilter(dateStr);
  const res = await fetch(`${cfg.url}/rest/v1/plts_telemetry?select=ts${filter}`, {
    method: "HEAD",
    headers: sbHeaders(cfg.key, { Prefer: "count=exact" }),
  });
  if (!res.ok) return 0;
  const range = res.headers.get("content-range") || "";
  const slashIdx = range.indexOf("/");
  if (slashIdx < 0) return 0;
  const n = Number(range.slice(slashIdx + 1));
  return Number.isFinite(n) ? n : 0;
}

async function fetchChartDay(cfg, dateStr) {
  const all = [];
  let rpcOk = false;

  // Jalur cepat: RPC get_plts_chart_day (maks 1440 titik/menit dalam 24 jam)
  for (const [from, to] of [[0, 999], [1000, 1999]]) {
    const res = await fetch(`${cfg.url}/rest/v1/rpc/get_plts_chart_day`, {
      method: "POST",
      headers: sbHeaders(cfg.key, { Range: `${from}-${to}` }),
      body: JSON.stringify({ p_date: dateStr }),
    });
    if (!res.ok) break;
    rpcOk = true;
    const chunk = await res.json();
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    all.push(...chunk);
    if (chunk.length < 1000) break;
  }

  // Fallback otomatis jika RPC get_plts_chart_day belum terpasang: tarik & resample 1 titik/menit
  if (!rpcOk && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const filter = buildDateRangeFilter(dateStr);
    const byMin = new Map();
    for (let page = 0; page < 90; page++) {
      const from = page * 1000;
      const to = from + 999;
      const res = await fetch(
        `${cfg.url}/rest/v1/plts_telemetry?select=ts,lux,temp_c,pv_p,mppt_p,batt_p,load_p${filter}&order=ts.asc`,
        { headers: sbHeaders(cfg.key, { Range: `${from}-${to}` }) }
      );
      if (!res.ok) break;
      const chunk = await res.json();
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      for (const r of chunk) {
        if (typeof r.ts === "string" && r.ts.length >= 16) {
          byMin.set(r.ts.slice(0, 16), r);
        }
      }
      if (chunk.length < 1000) break;
    }
    all.push(...Array.from(byMin.values()));
  }

  return all.map((r) => ({
    ts: r.ts,
    lux: Number(r.lux || 0),
    temp: Number(r.temp_c || 0),
    pv: { v: 0, i: 0, p: Number(r.pv_p || 0) },
    mppt: { v: 0, i: 0, p: Number(r.mppt_p || 0) },
    batt: { v: 0, i: 0, p: Number(r.batt_p || 0) },
    load: { v: 0, i: 0, p: Number(r.load_p || 0) },
  }));
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const cfg = getSupabaseCfg();
  if (cfg.error) {
    return res.status(503).json({
      ok: false,
      cloud: false,
      error: cfg.error,
    });
  }

  try {
    // ==================== GET ====================
    if (req.method === "GET") {
      const mode = req.query?.mode ? String(req.query.mode) : "";
      const format = req.query?.format ? String(req.query.format) : "";
      const filterDate = req.query?.date ? String(req.query.date).trim() : "";

      // 1. Export CSV langsung dari Supabase (15 kolom persis Arduino)
      if (format === "csv") {
        const csvLines = [CSV_HEADER];
        const pageSize = 1000;
        const maxPages = 90;
        const dateFilter = buildDateRangeFilter(filterDate);

        for (let page = 0; page < maxPages; page++) {
          const from = page * pageSize;
          const to = from + pageSize - 1;
          const url = `${cfg.url}/rest/v1/plts_telemetry?select=ts,lux,temp_c,pv_v,pv_i,pv_p,mppt_v,mppt_i,mppt_p,batt_v,batt_i,batt_p,load_v,load_i,load_p${dateFilter}&order=ts.asc`;

          const r = await fetch(url, {
            headers: sbHeaders(cfg.key, { Range: `${from}-${to}` }),
          });
          if (!r.ok) {
            const errTxt = await r.text();
            return res.status(500).json({ ok: false, error: errTxt });
          }
          const rows = await r.json();
          if (!Array.isArray(rows) || rows.length === 0) break;
          for (const row of rows) csvLines.push(dbRowToCsv(row));
          if (rows.length < pageSize) break;
        }

        const fname =
          filterDate && filterDate !== "ALL"
            ? `${filterDate}.csv`
            : `barokah_jaya_plts_cloud_all.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
        return res.status(200).send(csvLines.join("\n"));
      }

      // 2. Data Grafik 24 Jam untuk 1 tanggal spesifik
      if (mode === "chart" && filterDate) {
        const chartPoints = await fetchChartDay(cfg, filterDate);
        return res.status(200).json({
          ok: true,
          cloud: true,
          date: filterDate,
          count: chartPoints.length,
          data: chartPoints,
        });
      }

      // 3. Preview 20 baris terbaru untuk filter tanggal di tabel Dataset (lintas perangkat identik)
      if (mode === "table") {
        const limit = Math.min(50, Math.max(1, Number(req.query?.limit || 20)));
        const dateFilter = buildDateRangeFilter(filterDate);
        const url = `${cfg.url}/rest/v1/plts_telemetry?select=ts,sd,lux,temp_c,pv_v,pv_i,pv_p,mppt_v,mppt_i,mppt_p,batt_v,batt_i,batt_p,load_v,load_i,load_p${dateFilter}&order=ts.desc&limit=${limit}`;
        const r = await fetch(url, { headers: sbHeaders(cfg.key) });
        if (!r.ok) {
          const errTxt = await r.text();
          return res.status(502).json({ ok: false, cloud: false, error: errTxt });
        }
        const rows = await r.json();
        return res.status(200).json({
          ok: true,
          cloud: true,
          date: filterDate || "ALL",
          data: Array.isArray(rows) ? rows.map(dbRowToClient) : [],
        });
      }

      // 4. Ringkasan saat website dibuka/refresh/polling (Tanggal + Total + 30 baris terbaru + Grafik Hari Ini)
      if (mode === "summary") {
        const targetDate = filterDate || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

        const [datesRes, latestRes, chartToday] = await Promise.all([
          fetch(`${cfg.url}/rest/v1/rpc/get_plts_dates`, {
            method: "POST",
            headers: sbHeaders(cfg.key),
            body: "{}",
          }),
          fetch(
            `${cfg.url}/rest/v1/plts_telemetry?select=ts,sd,lux,temp_c,pv_v,pv_i,pv_p,mppt_v,mppt_i,mppt_p,batt_v,batt_i,batt_p,load_v,load_i,load_p&order=ts.desc&limit=30`,
            { headers: sbHeaders(cfg.key) }
          ),
          fetchChartDay(cfg, targetDate),
        ]);

        // Jangan telan error Supabase! Jika tabel utama gagal diakses (mis. PGRST125/key salah), laporkan jujur!
        if (!latestRes.ok) {
          const errTxt = await latestRes.text();
          return res.status(502).json({
            ok: false,
            cloud: false,
            error: `Supabase Error (${latestRes.status}): ${errTxt}`,
          });
        }

        const latestRaw = await latestRes.json();
        let dates = [];
        let totalCount = 0;
        let todayCount = 0;

        if (datesRes.ok) {
          const datesRaw = await datesRes.json();
          dates = Array.isArray(datesRaw)
            ? datesRaw.map((d) => ({ date: d.date_key, count: Number(d.row_count || 0) }))
            : [];
          totalCount = dates.reduce((acc, item) => acc + item.count, 0);
          const todayEntry = dates.find((d) => d.date === targetDate);
          todayCount = todayEntry ? todayEntry.count : 0;
        } else {
          // Fallback jika RPC get_plts_dates belum ada: hitung persis lewat header Content-Range
          [totalCount, todayCount] = await Promise.all([
            fetchExactCount(cfg),
            fetchExactCount(cfg, targetDate),
          ]);
          const dateSet = new Set([targetDate]);
          for (const r of latestRaw) {
            if (typeof r.ts === "string" && r.ts.length >= 10) dateSet.add(r.ts.slice(0, 10));
          }
          dates = Array.from(dateSet).sort().reverse().map((dt) => ({
            date: dt,
            count: dt === targetDate ? todayCount : 0,
          }));
        }

        return res.status(200).json({
          ok: true,
          cloud: true,
          totalCount,
          todayCount,
          dates,
          latest: Array.isArray(latestRaw) ? latestRaw.map(dbRowToClient).reverse() : [],
          chartToday,
        });
      }

      // 5. Default GET: 50 baris terbaru
      const dateQuery = buildDateRangeFilter(filterDate);
      const r = await fetch(
        `${cfg.url}/rest/v1/plts_telemetry?select=*${dateQuery}&order=ts.desc&limit=50`,
        { headers: sbHeaders(cfg.key) }
      );
      if (!r.ok) {
        const errTxt = await r.text();
        return res.status(502).json({ ok: false, cloud: false, error: errTxt });
      }
      const rows = await r.json();
      return res.status(200).json({
        ok: true,
        cloud: true,
        date: filterDate || "all",
        count: rows.length,
        data: rows.map(dbRowToClient).reverse(),
      });
    }

    // ==================== POST (UPSERT ANTI-DUPLIKAT) ====================
    if (req.method === "POST") {
      const rawBody = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const incoming = Array.isArray(rawBody)
        ? rawBody
        : Array.isArray(rawBody?.batch)
          ? rawBody.batch
          : [rawBody];

      const map = new Map();
      for (const item of incoming) {
        const clean = normalizeIncoming(item);
        if (clean) map.set(clean.ts, clean);
      }
      const rows = Array.from(map.values());
      if (rows.length === 0) {
        return res.status(400).json({ ok: false, error: "Payload sensor tidak valid" });
      }

      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows.slice(i, i + 500);
        const up = await fetch(`${cfg.url}/rest/v1/plts_telemetry?on_conflict=ts`, {
          method: "POST",
          headers: sbHeaders(cfg.key, {
            Prefer: "resolution=ignore-duplicates,return=minimal",
          }),
          body: JSON.stringify(slice),
        });
        if (!up.ok) {
          const errTxt = await up.text();
          return res.status(500).json({ ok: false, error: errTxt });
        }
      }

      return res.status(200).json({ ok: true, cloud: true, inserted: rows.length });
    }

    // ==================== DELETE ====================
    if (req.method === "DELETE") {
      const filterDate = req.query?.date ? String(req.query.date).trim() : "";
      const filterParam =
        filterDate && filterDate !== "ALL" && /^\d{4}-\d{2}-\d{2}$/.test(filterDate)
          ? `ts=gte.${encodeURIComponent(filterDate + " 00:00:00")}&ts=lte.${encodeURIComponent(filterDate + " 23:59:59")}`
          : `ts=not.is.null`;

      const del = await fetch(`${cfg.url}/rest/v1/plts_telemetry?${filterParam}`, {
        method: "DELETE",
        headers: sbHeaders(cfg.key),
      });
      if (!del.ok) {
        const errTxt = await del.text();
        return res.status(500).json({ ok: false, error: errTxt });
      }
      return res.status(200).json({ ok: true, cloud: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
};
