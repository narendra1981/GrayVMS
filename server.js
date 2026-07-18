require('dotenv').config();

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const twilio = require('twilio');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = process.env.PORT || 3000;
const rtsp = process.env.RTSP_URL || '';
const device = process.env.VIDEO_DEVICE || '/dev/video0';
const useTestPattern = process.env.TEST_PATTERN === '1';
const envVideoFile = process.env.VIDEO_FILE;
const videoFileDefault = 'video.mp4'; // fallback filename in public/
const camera1AlertThreshold = Number(process.env.CAMERA1_MAX_PEOPLE_ALERT_THRESHOLD || 10);
const smsAlertCooldownMs = Math.max(30, Number(process.env.SMS_ALERT_COOLDOWN_SECONDS || 300)) * 1000;
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID || '';
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || '';
const twilioFromNumber = process.env.TWILIO_FROM_NUMBER || '';
const twilioToNumbers = (process.env.TWILIO_TO_NUMBERS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const twilioWhatsappFrom = process.env.TWILIO_WHATSAPP_FROM || '';
const twilioWhatsappToNumbers = (process.env.TWILIO_WHATSAPP_TO_NUMBERS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const analyticsDbPath = process.env.ANALYTICS_DB_PATH || path.join(__dirname, 'analytics', 'grayvms_analytics.db');

const twilioClient = twilioAccountSid && twilioAuthToken
  ? twilio(twilioAccountSid, twilioAuthToken)
  : null;

let smsConfigWarningShown = false;
let camera1AlertPreviousActive = false;
let lastCamera1SmsSentAt = 0;
let analyticsDb = null;
let analyticsDbReady = false;
let analyticsDbWriteQueue = Promise.resolve();

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!analyticsDb) {
      resolve({ lastID: null, changes: 0 });
      return;
    }

    analyticsDb.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!analyticsDb) {
      resolve([]);
      return;
    }

    analyticsDb.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

function toFiniteNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function setupAnalyticsDbSchema() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS analytics_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      camera_id INTEGER NOT NULL,
      video TEXT,
      sampled_frames INTEGER,
      frame_count INTEGER,
      fps REAL,
      max_people REAL,
      average_people REAL,
      min_people REAL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS analytics_person_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      camera_id INTEGER NOT NULL,
      sample_index INTEGER NOT NULL,
      timestamp_seconds REAL,
      person_count INTEGER,
      crowd_density REAL,
      is_crowd INTEGER,
      crowd_size INTEGER,
      FOREIGN KEY(snapshot_id) REFERENCES analytics_snapshots(id)
    )
  `);

  await dbRun('CREATE INDEX IF NOT EXISTS idx_snapshots_camera_created_at ON analytics_snapshots(camera_id, created_at DESC)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_person_counts_snapshot_id ON analytics_person_counts(snapshot_id)');
}

async function persistAnalyticsForCamera(camera = 1) {
  if (!analyticsDbReady || !analyticsDb) return;

  const filePath = path.join(__dirname, 'analytics', camera === 1 ? 'person_counts.json' : 'person_counts2.json');
  let raw;
  let payload;

  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
    payload = JSON.parse(raw);
  } catch (err) {
    return;
  }

  await dbRun('BEGIN TRANSACTION');
  try {
    const snapshotInsert = await dbRun(
      `INSERT INTO analytics_snapshots (
        camera_id,
        video,
        sampled_frames,
        frame_count,
        fps,
        max_people,
        average_people,
        min_people,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        camera,
        payload.video || null,
        toFiniteNumberOrNull(payload.sampled_frames),
        toFiniteNumberOrNull(payload.frame_count),
        toFiniteNumberOrNull(payload.fps),
        toFiniteNumberOrNull(payload.max_people),
        toFiniteNumberOrNull(payload.average_people),
        toFiniteNumberOrNull(payload.min_people),
        raw,
        new Date().toISOString(),
      ],
    );

    const snapshotId = snapshotInsert.lastID;
    if (snapshotId && Array.isArray(payload.person_counts)) {
      for (let i = 0; i < payload.person_counts.length; i += 1) {
        const sample = payload.person_counts[i] || {};
        await dbRun(
          `INSERT INTO analytics_person_counts (
            snapshot_id,
            camera_id,
            sample_index,
            timestamp_seconds,
            person_count,
            crowd_density,
            is_crowd,
            crowd_size
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            snapshotId,
            camera,
            i,
            toFiniteNumberOrNull(sample.timestamp_seconds),
            toFiniteNumberOrNull(sample.person_count),
            toFiniteNumberOrNull(sample.crowd_density),
            sample.is_crowd ? 1 : 0,
            toFiniteNumberOrNull(sample.crowd_size),
          ],
        );
      }
    }

    await dbRun('COMMIT');
  } catch (err) {
    try {
      await dbRun('ROLLBACK');
    } catch (rollbackErr) {
      // Ignore rollback failures and report original error below.
    }
    console.error(`Analytics DB persist failed for camera ${camera}:`, err.message || err);
  }
}

function queueAnalyticsPersist(camera = 1) {
  if (!analyticsDbReady || !analyticsDb) return;
  analyticsDbWriteQueue = analyticsDbWriteQueue
    .then(() => persistAnalyticsForCamera(camera))
    .catch((err) => {
      console.error('Analytics DB queue error:', err.message || err);
    });
}

function initAnalyticsDb() {
  try {
    fs.mkdirSync(path.dirname(analyticsDbPath), { recursive: true });
    analyticsDb = new sqlite3.Database(analyticsDbPath, async (err) => {
      if (err) {
        console.error('Analytics DB initialization failed:', err.message || err);
        analyticsDb = null;
        analyticsDbReady = false;
        return;
      }

      try {
        await setupAnalyticsDbSchema();
        analyticsDbReady = true;
        console.log(`Analytics DB ready at ${analyticsDbPath}`);
        queueAnalyticsPersist(1);
        queueAnalyticsPersist(2);
      } catch (schemaErr) {
        console.error('Analytics DB schema setup failed:', schemaErr.message || schemaErr);
        analyticsDbReady = false;
      }
    });
  } catch (err) {
    console.error('Analytics DB startup failed:', err.message || err);
  }
}

function closeAnalyticsDb() {
  if (!analyticsDb) return;
  analyticsDb.close((err) => {
    if (err) {
      console.error('Analytics DB close failed:', err.message || err);
      return;
    }
    console.log('Analytics DB closed');
  });
  analyticsDb = null;
  analyticsDbReady = false;
}

function resolvePreferredVideo(camera = 1) {
  // Priority: explicit env VIDEO_FILE (absolute or relative to project root),
  // then browser-friendly project-root videos (mp4/webm/ogg),
  // then legacy AVI, then `public/video.mp4`.
  if (camera === 1 && envVideoFile) return path.isAbsolute(envVideoFile) ? envVideoFile : path.join(__dirname, envVideoFile);

  const playableCandidates = camera === 1
    ? [
        path.join(__dirname, 'video.mp4'),
        path.join(__dirname, 'Test.mp4'),
        path.join(__dirname, 'Test_1.mp4'),
        path.join(__dirname, 'July_07.mp4'),
        path.join(__dirname, 'video_1.mp4'),
      ]
    : [
        path.join(__dirname, 'video_09_07.mp4'),
        path.join(__dirname, 'Test.mp4'),
        path.join(__dirname, 'Test_1.mp4'),
        path.join(__dirname, 'video_1.mp4'),
        path.join(__dirname, 'July_07.mp4'),
        path.join(__dirname, 'video.mp4'),
      ];

  for (const candidate of playableCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const legacyAvi = path.join(__dirname, 'output_2min.avi');
  if (fs.existsSync(legacyAvi)) return legacyAvi;

  return path.join(__dirname, 'public', videoFileDefault);
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.ogg' || ext === '.ogv') return 'video/ogg';
  if (ext === '.avi') return 'video/x-msvideo';
  return 'application/octet-stream';
}

const dashboardHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>GrayVMS Live View</title>
    <style>
      :root { color-scheme: dark; }
      body {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        margin: 0;
        padding: 1rem;
        background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 25%, #2d2d2d 50%, #1a1a1a 75%, #0a0a0a 100%);
        color: #e8e8e8;
        min-height: 100vh;
        overflow-y: auto;
        overflow-x: hidden;
      }
      h1 {
        margin: 0 0 0.6rem;
        font-size: 1.55rem;
        letter-spacing: 0.05em;
        color: #d4af37;
        text-shadow: 0 2px 10px rgba(212, 175, 55, 0.3);
        font-weight: 700;
      }
      .container {
        max-width: 1600px;
        margin: 0 auto;
        min-height: calc(100vh - 2rem);
        display: flex;
        flex-direction: column;
        transform: scale(0.95);
        transform-origin: top center;
        width: 105.2632%;
      }
      .content {
        display: grid;
        grid-template-columns: minmax(560px, 1.15fr) minmax(420px, 0.85fr);
        gap: 0.9rem;
        align-items: flex-start;
        flex: 1;
        min-height: 0;
      }
      .video-panel {
        min-width: 0;
      }
      .video-panel .panel-box {
        padding: 0.75rem;
      }
      .video-panel .trend-chart-wrap {
        margin-top: 0.45rem;
      }
      .analytics-section {
        min-width: 0;
        max-height: none;
        overflow: visible;
        transform: scale(0.85);
        transform-origin: top left;
        width: 117.5%;
      }
      .analytics-title {
        font-size: 1.05rem;
        margin: 0 0 0.55rem;
        letter-spacing: 0.06em;
      }
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 0.34rem;
        margin-bottom: 0.42rem;
      }
      .stat-box {
        background: linear-gradient(135deg, #1f1f1f 0%, #2a2a2a 100%);
        border: 1.5px solid #d4af37;
        border-radius: 7px;
        padding: 0.3rem 0.25rem;
        text-align: center;
        transition: all 0.3s ease;
        box-shadow: 0 4px 15px rgba(212, 175, 55, 0.1);
        position: relative;
        overflow: hidden;
        min-height: 42px;
      }
      .stat-label {
        font-size: 0.54rem;
        color: #999;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: 0.14rem;
        font-weight: 500;
        line-height: 1.1;
      }
      .stat-value {
        font-size: 0.82rem;
        color: #d4af37;
        font-weight: 700;
        font-family: 'Courier New', monospace;
        line-height: 1.15;
      }
      .metric-good {
        color: #22c55e;
      }
      .metric-bad {
        color: #ef4444;
      }
      .metric-neutral {
        color: #d4af37;
      }
      .info-box {
        background: linear-gradient(135deg, #1f1f1f 0%, #2a2a2a 100%);
        border: 1.5px solid #d4af37;
        border-radius: 7px;
        padding: 0.4rem 0.52rem;
        margin-bottom: 0.42rem;
      }
      .info-label {
        font-size: 0.58rem;
        color: #999;
        margin-bottom: 0.1rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .info-value {
        font-size: 0.72rem;
        color: #e8e8e8;
        word-break: break-all;
        font-family: 'Courier New', monospace;
      }
      .trend-caption {
        color: #d4af37;
        font-size: 0.68rem;
        margin-bottom: 0.2rem;
        font-weight: 600;
      }
      .trend-legend {
        display: flex;
        gap: 0.55rem;
        margin-bottom: 0.25rem;
        font-size: 0.62rem;
        color: #bcbcbc;
      }
      .trend-canvas {
        width: 100%;
        height: 96px;
        display: block;
        border-radius: 8px;
        background: #111;
        border: 1px solid rgba(212, 175, 55, 0.25);
      }
      .metric-heading {
        color: #d4af37;
        font-size: 0.66rem;
        margin: 0.35rem 0 0.22rem;
        font-weight: 600;
        letter-spacing: 0.03em;
      }

      @media (max-width: 1320px) {
        .stats-grid {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }
      }
      @media (max-width: 1100px) {
        body {
          height: auto;
          overflow: auto;
        }
        .container {
          height: auto;
          transform: none;
          width: 100%;
        }
        .content {
          grid-template-columns: 1fr;
          gap: 1rem;
        }
        .analytics-section {
          transform: none;
          width: 100%;
        }
        .stats-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .panel-box {
        border: 2px solid #d4af37;
        box-shadow: 0 8px 32px rgba(212, 175, 55, 0.15), inset 0 1px 0 rgba(212, 175, 55, 0.1);
        border-radius: 12px;
        background: linear-gradient(135deg, #1a1a1a 0%, #242424 100%);
        padding: 1.2rem;
        position: relative;
        overflow: hidden;
      }
      .panel-box::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 2px;
        background: linear-gradient(90deg, transparent, #d4af37, transparent);
      }
      .stream {
        width: 100%;
        max-width: 100%;
        height: auto;
        display: block;
        border-radius: 8px;
        background: #000;
        border: 1px solid rgba(212, 175, 55, 0.2);
      }
      .video-wrap {
        position: relative;
        width: 100%;
      }
      .bbox-overlay {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        border-radius: 8px;
      }
      .trend-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 999px;
        margin-right: 0.35rem;
      }
      @media (max-width: 768px) {
        h1 { font-size: 1.8rem; }
        .content { gap: 1rem; }
        .stats-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>🎬 GrayVMS Live View</h1>
      <div class="content">
        <div class="video-panel">
          <div class="panel-box">
            <div class="video-wrap">
              <video id="live-video" class="stream" controls autoplay loop muted playsinline src="/video.mp4"></video>
              <canvas id="bbox-overlay" class="bbox-overlay"></canvas>
            </div>
            <div class="trend-chart-wrap">
              <div class="trend-caption">📉 Crowd Trend (Live)</div>
              <div class="trend-legend">
                <span><span class="trend-dot" style="background:#d4af37;"></span>People Count</span>
                <span><span class="trend-dot" style="background:#1ecbe1;"></span>Crowd Density %</span>
              </div>
              <canvas id="analytics-trend-canvas" class="trend-canvas"></canvas>
            </div>
          </div>
        </div>
        <div class="analytics-section">
          <div class="analytics-title">📊 Person Analytics</div>
          <div class="metric-heading">👤 People Detection</div>
          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-label">Max People</div>
              <div class="stat-value" id="analytics-max">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Avg People</div>
              <div class="stat-value" id="analytics-average">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Min People</div>
              <div class="stat-value" id="analytics-min">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Sampled</div>
              <div class="stat-value" id="analytics-sampled">-</div>
            </div>
          </div>
          <div class="metric-heading">🎯 Object Detection</div>
          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-label">Max Objects</div>
              <div class="stat-value" id="analytics-max-objects">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Avg Objects</div>
              <div class="stat-value" id="analytics-avg-objects">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Min Objects</div>
              <div class="stat-value" id="analytics-min-objects">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Motion %</div>
              <div class="stat-value" id="analytics-motion-percent">-</div>
            </div>
          </div>
          <div class="metric-heading">👥 Crowd Analysis</div>
          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-label">Crowd Frames</div>
              <div class="stat-value" id="analytics-crowd-frames">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Crowd %</div>
              <div class="stat-value" id="analytics-crowd-percent">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Max Crowd Size</div>
              <div class="stat-value" id="analytics-max-crowd">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Avg Crowd Size</div>
              <div class="stat-value" id="analytics-avg-crowd">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Avg Crowd Score</div>
              <div class="stat-value" id="analytics-avg-crowd-score">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Peak Crowd Score</div>
              <div class="stat-value" id="analytics-peak-crowd-score">-</div>
            </div>
          </div>
          <div class="metric-heading">📊 Density Analysis</div>
          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-label">Max Density</div>
              <div class="stat-value" id="analytics-max-density">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Avg Density</div>
              <div class="stat-value" id="analytics-avg-density">-</div>
            </div>
          </div>
          <div class="metric-heading">🔍 Motion Analysis</div>
          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-label">Frames w/ Motion</div>
              <div class="stat-value" id="analytics-motion-frames">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Total Duration</div>
              <div class="stat-value" id="analytics-duration">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">FPS</div>
              <div class="stat-value" id="analytics-fps">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Frame Count</div>
              <div class="stat-value" id="analytics-frame-count">-</div>
            </div>
          </div>
          <div class="metric-heading">📈 Advanced Analytics</div>
          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-label">Median People</div>
              <div class="stat-value" id="analytics-median">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">People Std Dev</div>
              <div class="stat-value" id="analytics-stddev">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Peak Time</div>
              <div class="stat-value" id="analytics-peak-time">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">People Change/s</div>
              <div class="stat-value" id="analytics-change-sec">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Rapid Change Frames</div>
              <div class="stat-value" id="analytics-rapid-frames">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Unique Obj Types</div>
              <div class="stat-value" id="analytics-unique-types">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Avg Obj Diversity</div>
              <div class="stat-value" id="analytics-diversity">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Crowd Events</div>
              <div class="stat-value" id="analytics-crowd-events">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Longest Crowd</div>
              <div class="stat-value" id="analytics-longest-crowd">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">People Trend</div>
              <div class="stat-value" id="analytics-people-trend">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Density Trend</div>
              <div class="stat-value" id="analytics-density-trend">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">People Slope</div>
              <div class="stat-value" id="analytics-people-slope">-</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Density Slope</div>
              <div class="stat-value" id="analytics-density-slope">-</div>
            </div>
          </div>
          <div class="info-box">
            <div class="info-label">Top Detected Objects</div>
            <div class="info-value" id="analytics-top-objects">-</div>
          </div>
        </div>
      </div>
    </div>
    <script>
      let latestAnalytics = null;

      function setMetricState(elementId, numericValue, averageValue) {
        const element = document.getElementById(elementId);
        if (!element) return;

        element.classList.remove('metric-good', 'metric-bad', 'metric-neutral');

        const value = Number(numericValue);
        const average = Number(averageValue);
        if (!Number.isFinite(value) || !Number.isFinite(average) || average <= 0) {
          element.classList.add('metric-neutral');
          return;
        }

        if (value > average) {
          element.classList.add('metric-good');
          return;
        }

        if (value < average * 0.5) {
          element.classList.add('metric-bad');
          return;
        }

        element.classList.add('metric-neutral');
      }

      function drawSeries(ctx, points, color, width, pad, chartW, chartH) {
        if (!points || points.length === 0) return;
        ctx.beginPath();
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        points.forEach((point, index) => {
          const x = pad + (index * chartW) / Math.max(1, points.length - 1);
          const y = pad + chartH - (point * chartH);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      function drawCrowdTrend(data) {
        const canvas = document.getElementById('analytics-trend-canvas');
        if (!canvas || !data || !Array.isArray(data.person_counts) || data.person_counts.length === 0) return;

        const width = Math.max(320, Math.floor(canvas.clientWidth || 320));
        const height = 96;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const pad = 12;
        const chartW = width - pad * 2;
        const chartH = height - pad * 2;

        const points = data.person_counts;
        const peopleValues = points.map((item) => Number(item.person_count) || 0);
        const densityValues = points.map((item) => Number(item.crowd_density) || 0);

        const maxPeople = Math.max(1, ...peopleValues);
        const maxDensity = Math.max(1, ...densityValues);
        const peopleNorm = peopleValues.map((v) => v / maxPeople);
        const densityNorm = densityValues.map((v) => v / maxDensity);

        ctx.clearRect(0, 0, width, height);

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i += 1) {
          const y = pad + (chartH * i) / 4;
          ctx.beginPath();
          ctx.moveTo(pad, y);
          ctx.lineTo(pad + chartW, y);
          ctx.stroke();
        }

        drawSeries(ctx, densityNorm, '#1ecbe1', 2, pad, chartW, chartH);
        drawSeries(ctx, peopleNorm, '#d4af37', 2.5, pad, chartW, chartH);
      }

      function getNearestSampleByTime(samples, seconds) {
        if (!Array.isArray(samples) || samples.length === 0) return null;
        let best = samples[0];
        let bestDiff = Math.abs((samples[0].timestamp_seconds || 0) - seconds);
        for (let i = 1; i < samples.length; i += 1) {
          const sample = samples[i];
          const diff = Math.abs((sample.timestamp_seconds || 0) - seconds);
          if (diff < bestDiff) {
            best = sample;
            bestDiff = diff;
          }
        }
        return best;
      }

      function drawPersonBoxesAtCurrentTime() {
        const video = document.getElementById('live-video');
        const canvas = document.getElementById('bbox-overlay');
        if (!video || !canvas) return;

        const width = Math.max(1, Math.floor(video.clientWidth || 1));
        const height = Math.max(1, Math.floor(video.clientHeight || 1));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);

        if (!latestAnalytics || !Array.isArray(latestAnalytics.person_counts)) return;

        const currentSec = Number(video.currentTime || 0);
        const nearestSample = getNearestSampleByTime(latestAnalytics.person_counts, currentSec);
        if (!nearestSample || !Array.isArray(nearestSample.person_boxes)) return;

        ctx.lineWidth = 2;
        ctx.strokeStyle = '#34d399';
        ctx.fillStyle = 'rgba(52, 211, 153, 0.16)';
        ctx.font = '11px monospace';

        nearestSample.person_boxes.forEach((box) => {
          const x1 = (Number(box.x1) || 0) * width;
          const y1 = (Number(box.y1) || 0) * height;
          const x2 = (Number(box.x2) || 0) * width;
          const y2 = (Number(box.y2) || 0) * height;
          const w = Math.max(0, x2 - x1);
          const h = Math.max(0, y2 - y1);
          if (w < 2 || h < 2) return;

          ctx.fillRect(x1, y1, w, h);
          ctx.strokeRect(x1, y1, w, h);

          const conf = Number(box.conf || 0).toFixed(2);
          const label = 'person ' + conf;
          const ly = Math.max(11, y1 - 4);
          ctx.fillStyle = 'rgba(0,0,0,0.65)';
          const tw = ctx.measureText(label).width + 6;
          ctx.fillRect(x1, ly - 11, tw, 12);
          ctx.fillStyle = '#86efac';
          ctx.fillText(label, x1 + 3, ly - 2);
          ctx.fillStyle = 'rgba(52, 211, 153, 0.16)';
        });
      }

      async function refreshAnalytics() {
        try {
          const res = await fetch('/analytics/person_counts.json');
          if (!res.ok) return;
          const data = await res.json();
          
          // People detection
          document.getElementById('analytics-sampled').textContent = data.sampled_frames ?? '-';
          document.getElementById('analytics-max').textContent = data.max_people ?? '-';
          document.getElementById('analytics-average').textContent = data.average_people ?? '-';
          document.getElementById('analytics-min').textContent = data.min_people ?? '-';
          setMetricState('analytics-max', data.max_people, data.average_people);
          setMetricState('analytics-min', data.min_people, data.average_people);
          setMetricState('analytics-average', data.average_people, data.average_people);
          
          // Object detection
          document.getElementById('analytics-max-objects').textContent = data.max_objects ?? '-';
          document.getElementById('analytics-avg-objects').textContent = data.average_objects ?? '-';
          document.getElementById('analytics-min-objects').textContent = data.min_objects ?? '-';
          document.getElementById('analytics-motion-percent').textContent = (data.motion_percentage ?? 0) + '%';
          setMetricState('analytics-max-objects', data.max_objects, data.average_objects);
          setMetricState('analytics-min-objects', data.min_objects, data.average_objects);
          setMetricState('analytics-avg-objects', data.average_objects, data.average_objects);
          
          // Crowd analysis
          const crowdAnalysis = data.crowd_analysis || {};
          document.getElementById('analytics-crowd-frames').textContent = crowdAnalysis.total_crowd_frames ?? '-';
          document.getElementById('analytics-crowd-percent').textContent = (crowdAnalysis.crowd_percentage ?? 0) + '%';
          document.getElementById('analytics-max-crowd').textContent = crowdAnalysis.max_crowd_size ?? '-';
          document.getElementById('analytics-avg-crowd').textContent = crowdAnalysis.average_crowd_size ?? '-';
          document.getElementById('analytics-avg-crowd-score').textContent = crowdAnalysis.average_crowd_score ?? '-';
          document.getElementById('analytics-peak-crowd-score').textContent = crowdAnalysis.peak_crowd_score ?? '-';
          setMetricState('analytics-max-crowd', crowdAnalysis.max_crowd_size, crowdAnalysis.average_crowd_size);
          setMetricState('analytics-avg-crowd', crowdAnalysis.average_crowd_size, crowdAnalysis.average_crowd_size);
          setMetricState('analytics-peak-crowd-score', crowdAnalysis.peak_crowd_score, crowdAnalysis.average_crowd_score);
          setMetricState('analytics-avg-crowd-score', crowdAnalysis.average_crowd_score, crowdAnalysis.average_crowd_score);
          
          // Density analysis
          const densityAnalysis = data.density_analysis || {};
          document.getElementById('analytics-max-density').textContent = (densityAnalysis.max_density ?? 0) + '%';
          document.getElementById('analytics-avg-density').textContent = (densityAnalysis.average_density ?? 0) + '%';
          setMetricState('analytics-max-density', densityAnalysis.max_density, densityAnalysis.average_density);
          setMetricState('analytics-avg-density', densityAnalysis.average_density, densityAnalysis.average_density);
          
          // Motion analysis
          document.getElementById('analytics-motion-frames').textContent = data.frames_with_motion ?? '-';
          document.getElementById('analytics-duration').textContent = (data.duration_seconds ?? 0) + 's';
          document.getElementById('analytics-fps').textContent = data.fps ?? '-';
          document.getElementById('analytics-frame-count').textContent = data.frame_count ?? '-';

          // Advanced analytics
          const objectAnalysis = data.object_analysis || {};
          const topObjects = (objectAnalysis.top_detected_objects || [])
            .map((item) => item.type + ':' + item.count)
            .join(', ');
          document.getElementById('analytics-median').textContent = data.median_people ?? '-';
          document.getElementById('analytics-stddev').textContent = data.people_std_dev ?? '-';
          document.getElementById('analytics-peak-time').textContent = (data.peak_occupancy_time_seconds ?? 0) + 's';
          document.getElementById('analytics-change-sec').textContent = data.average_people_change_per_second ?? '-';
          document.getElementById('analytics-rapid-frames').textContent = data.rapid_change_frames ?? '-';
          document.getElementById('analytics-unique-types').textContent = objectAnalysis.unique_object_types ?? '-';
          document.getElementById('analytics-diversity').textContent = objectAnalysis.average_object_type_diversity ?? '-';
          document.getElementById('analytics-crowd-events').textContent = crowdAnalysis.crowd_event_count ?? '-';
          document.getElementById('analytics-longest-crowd').textContent = (crowdAnalysis.longest_crowd_event_seconds ?? 0) + 's';
          document.getElementById('analytics-top-objects').textContent = topObjects || 'N/A';

          // Crowd trend
          const trend = data.crowd_trend || {};
          document.getElementById('analytics-people-trend').textContent = trend.people_trend_direction || '-';
          document.getElementById('analytics-density-trend').textContent = trend.density_trend_direction || '-';
          document.getElementById('analytics-people-slope').textContent = trend.people_trend_slope_per_sample ?? '-';
          document.getElementById('analytics-density-slope').textContent = trend.density_trend_slope_per_sample ?? '-';
          setMetricState('analytics-median', data.median_people, data.average_people);

          latestAnalytics = data;
          drawPersonBoxesAtCurrentTime();
          drawCrowdTrend(data);
        } catch (e) {
                    // Keep existing values when refresh fails.
        }
      }
      refreshAnalytics();
      setInterval(refreshAnalytics, 5000);
      const liveVideo = document.getElementById('live-video');
      if (liveVideo) {
        liveVideo.addEventListener('timeupdate', drawPersonBoxesAtCurrentTime);
        liveVideo.addEventListener('seeked', drawPersonBoxesAtCurrentTime);
        liveVideo.addEventListener('loadedmetadata', drawPersonBoxesAtCurrentTime);
      }
      window.addEventListener('resize', () => {
        refreshAnalytics();
    </script>
  </body>
</html>`;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=ffserver');

  const ffmpegArgs = useTestPattern
    ? ['-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=25', '-f', 'mjpeg', '-q:v', '5', '-']
    : rtsp
      ? ['-rtsp_transport', 'tcp', '-i', rtsp, '-f', 'mjpeg', '-q:v', '5', '-r', '25', '-']
      : ['-f', 'v4l2', '-i', device, '-f', 'mjpeg', '-q:v', '5', '-r', '25', '-'];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'inherit'] });

  ffmpeg.stdout.on('data', (chunk) => {
    res.write(`--ffserver\r\nContent-Type: image/jpeg\r\nContent-Length: ${chunk.length}\r\n\r\n`);
    res.write(chunk);
  });

  ffmpeg.on('error', (err) => {
    console.error('ffmpeg error', err);
    res.end();
  });

  req.on('close', () => {
    try { ffmpeg.kill('SIGKILL'); } catch (e) {}
  });
});

// Serve stored video with range requests for HTML5 <video>
app.get('/video.mp4', (req, res) => {
  // determine which file to serve
  const filePath = resolvePreferredVideo(1);
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return res.status(404).end();

    const range = req.headers.range;
    const fileSize = stat.size;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      if (start >= fileSize || end >= fileSize) {
        res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
        return;
      }
      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeTypeFor(filePath),
      });
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeTypeFor(filePath),
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
});

// Camera 2 video with range requests
app.get('/video2.mp4', (req, res) => {
  const filePath = resolvePreferredVideo(2);
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return res.status(404).end();

    const range = req.headers.range;
    const fileSize = stat.size;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      if (start >= fileSize || end >= fileSize) {
        res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
        return;
      }
      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeTypeFor(filePath),
      });
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeTypeFor(filePath),
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
});
app.get('/video-info', (req, res) => {
  const filePath = resolvePreferredVideo(1);
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return res.json({ available: false });
    return res.json({
      available: true,
      file: path.basename(filePath),
      mime: mimeTypeFor(filePath),
      size: stat.size,
    });
  });
});

// Camera 2 video info
app.get('/video2-info', (req, res) => {
  const filePath = resolvePreferredVideo(2);
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return res.json({ available: false });
    return res.json({
      available: true,
      file: path.basename(filePath),
      mime: mimeTypeFor(filePath),
      size: stat.size,
    });
  });
});

app.get('/analytics/person_counts.json', (req, res) => {
  const filePath = path.join(__dirname, 'analytics', 'person_counts.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(404).json({ error: 'Analytics not found' });
    res.type('application/json').send(data);
  });
});

// Camera 2 analytics
app.get('/analytics/person_counts2.json', (req, res) => {
  const filePath = path.join(__dirname, 'analytics', 'person_counts2.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(404).json({ error: 'Analytics not found' });
    res.type('application/json').send(data);
  });
});

app.get('/analytics/db/recent', async (req, res) => {
  if (!analyticsDbReady || !analyticsDb) {
    return res.status(503).json({
      ready: false,
      rows: [],
      message: 'Analytics DB not ready',
    });
  }

  const limitParam = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, 200)
    : 30;

  try {
    const rows = await dbAll(
      `SELECT
         s.id,
         s.camera_id,
         s.max_people,
         s.average_people,
         s.min_people,
         s.sampled_frames,
         s.created_at,
         COALESCE(pc.sample_points, 0) AS sample_points
       FROM analytics_snapshots s
       LEFT JOIN (
         SELECT snapshot_id, COUNT(*) AS sample_points
         FROM analytics_person_counts
         GROUP BY snapshot_id
       ) pc
       ON pc.snapshot_id = s.id
       ORDER BY s.id DESC
       LIMIT ?`,
      [limit],
    );

    const totals = await dbAll(
      `SELECT
         (SELECT COUNT(*) FROM analytics_snapshots) AS total_snapshots,
         (SELECT COUNT(*) FROM analytics_person_counts) AS total_person_samples`,
      [],
    );

    return res.json({
      ready: true,
      totals: totals[0] || { total_snapshots: 0, total_person_samples: 0 },
      rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      ready: false,
      rows: [],
      message: err.message || 'Failed to read analytics database',
    });
  }
});

function evaluateCamera1Alert(callback) {
  const filePath = path.join(__dirname, 'analytics', 'person_counts.json');
  fs.readFile(filePath, 'utf8', (err, raw) => {
    if (err) {
      return callback({
        ok: false,
        statusCode: 404,
        payload: {
          camera: 1,
          threshold: camera1AlertThreshold,
          active: false,
          max_people: null,
          message: 'Analytics not found',
        },
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      return callback({
        ok: false,
        statusCode: 500,
        payload: {
          camera: 1,
          threshold: camera1AlertThreshold,
          active: false,
          max_people: null,
          message: 'Analytics parse error',
        },
      });
    }

    const maxPeople = Number(parsed.max_people || 0);
    const active = Number.isFinite(maxPeople) && maxPeople > camera1AlertThreshold;

    return callback({
      ok: true,
      statusCode: 200,
      payload: {
        camera: 1,
        threshold: camera1AlertThreshold,
        active,
        max_people: maxPeople,
        message: active
          ? `ALERT: Camera 1 reached ${maxPeople} people (threshold ${camera1AlertThreshold})`
          : `Camera 1 is normal (${maxPeople}/${camera1AlertThreshold})`,
        source_file: 'analytics/person_counts.json',
        updated_at: new Date().toISOString(),
      },
    });
  });
}

async function sendCamera1SmsAlert(message) {
  const smsConfigured = twilioClient && twilioFromNumber && twilioToNumbers.length > 0;
  const whatsappConfigured = twilioClient && twilioWhatsappFrom && twilioWhatsappToNumbers.length > 0;

  if (!smsConfigured && !whatsappConfigured) {
    if (!smsConfigWarningShown) {
      console.log('SMS/WhatsApp alerts disabled. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and channel-specific env vars to enable.');
      smsConfigWarningShown = true;
    }
    return;
  }

  const sends = [];
  if (smsConfigured) {
    twilioToNumbers.forEach((to) => {
      sends.push({
        channel: 'sms',
        to,
        promise: twilioClient.messages.create({
          body: message,
          from: twilioFromNumber,
          to,
        }),
      });
    });
  }

  if (whatsappConfigured) {
    twilioWhatsappToNumbers.forEach((toRaw) => {
      const to = toRaw.startsWith('whatsapp:') ? toRaw : `whatsapp:${toRaw}`;
      const from = twilioWhatsappFrom.startsWith('whatsapp:') ? twilioWhatsappFrom : `whatsapp:${twilioWhatsappFrom}`;
      sends.push({
        channel: 'whatsapp',
        to,
        promise: twilioClient.messages.create({
          body: message,
          from,
          to,
        }),
      });
    });
  }

  const results = await Promise.allSettled(sends.map((entry) => entry.promise));
  results.forEach((result, index) => {
    const target = sends[index];
    if (result.status === 'fulfilled') {
      console.log(`${target.channel.toUpperCase()} alert sent to ${target.to}: sid=${result.value.sid}`);
    } else {
      console.error(`${target.channel.toUpperCase()} alert failed for ${target.to}:`, result.reason?.message || result.reason);
    }
  });
}

function checkAndSendCamera1SmsAlert() {
  evaluateCamera1Alert(async (result) => {
    if (!result.ok) return;

    const { active, message } = result.payload;
    const now = Date.now();
    const shouldSend = active && (
      !camera1AlertPreviousActive ||
      now - lastCamera1SmsSentAt >= smsAlertCooldownMs
    );

    if (shouldSend) {
      try {
        await sendCamera1SmsAlert(message);
        lastCamera1SmsSentAt = now;
      } catch (err) {
        console.error('SMS alert send error:', err.message || err);
      }
    }

    camera1AlertPreviousActive = active;
  });
}

function maskConfigValue(value) {
  if (!value) return null;
  const raw = String(value);
  if (raw.length <= 4) return '****';
  return `${'*'.repeat(raw.length - 4)}${raw.slice(-4)}`;
}

app.get('/alerts/channels/status', (req, res) => {
  const twilioConfigured = Boolean(twilioClient);
  const smsConfigured = twilioConfigured && Boolean(twilioFromNumber) && twilioToNumbers.length > 0;
  const whatsappConfigured = twilioConfigured && Boolean(twilioWhatsappFrom) && twilioWhatsappToNumbers.length > 0;

  res.json({
    camera: 1,
    threshold: camera1AlertThreshold,
    cooldown_seconds: Math.floor(smsAlertCooldownMs / 1000),
    twilio: {
      configured: twilioConfigured,
      account_sid_masked: maskConfigValue(twilioAccountSid),
    },
    channels: {
      sms: {
        ready: smsConfigured,
        from_masked: maskConfigValue(twilioFromNumber),
        recipients_count: twilioToNumbers.length,
      },
      whatsapp: {
        ready: whatsappConfigured,
        from_masked: maskConfigValue(twilioWhatsappFrom),
        recipients_count: twilioWhatsappToNumbers.length,
      },
    },
    alert_state: {
      previously_active: camera1AlertPreviousActive,
      last_sent_at: lastCamera1SmsSentAt ? new Date(lastCamera1SmsSentAt).toISOString() : null,
    },
  });
});

app.get('/alerts/camera1/current', (req, res) => {
  evaluateCamera1Alert((result) => {
    if (!result.ok) {
      return res.status(result.statusCode).json(result.payload);
    }

    return res.status(200).json(result.payload);
  });
});

// Background analysis task - runs Python analytics periodically
function runAnalysisTask(camera = 1) {
  const videoPath = resolvePreferredVideo(camera);
  const outputPath = path.join(__dirname, 'analytics', camera === 1 ? 'person_counts.json' : 'person_counts2.json');
  const modelPath = path.join(__dirname, 'yolov8n.pt');
  
  // Check if video file exists
  if (!fs.existsSync(videoPath)) return;
  
  const python = spawn('python3', [
    path.join(__dirname, 'analytics', 'person_count.py'),
    videoPath,
    outputPath,
    modelPath
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  python.on('error', (err) => {
    console.error(`Analysis error (Camera ${camera}):`, err.message);
  });

  python.on('close', (code) => {
    if (code === 0) {
      queueAnalyticsPersist(camera);
    }
  });
}

// Manual endpoints to trigger analysis
app.get('/analyze', (req, res) => {
  runAnalysisTask(1);
  res.json({ status: 'Analysis started (Camera 1)' });
});

app.get('/analyze2', (req, res) => {
  runAnalysisTask(2);
  res.json({ status: 'Analysis started (Camera 2)' });
});

// Start background analysis every 5 seconds
let analysisInterval1 = null;
let analysisInterval2 = null;
let camera1SmsAlertInterval = null;
function startBackgroundAnalysis() {
  // Run initial analysis immediately
  runAnalysisTask(1);
  runAnalysisTask(2);
  checkAndSendCamera1SmsAlert();
  
  // Then run every 5 seconds
  analysisInterval1 = setInterval(() => runAnalysisTask(1), 5000);
  analysisInterval2 = setInterval(() => runAnalysisTask(2), 5000);
  camera1SmsAlertInterval = setInterval(checkAndSendCamera1SmsAlert, 5000);
  console.log('Background analysis started for both cameras (running every 5 seconds)');
}

// Serve main dashboard from index.html
app.get('/', (req, res) => {
  fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8', (err, data) => {
    if (err) return res.type('html').send(dashboardHtml); // fallback to embedded HTML
    res.type('html').send(data);
  });
});

// Camera 2 page
app.get('/camera2', (req, res) => {
  fs.readFile(path.join(__dirname, 'public', 'camera2.html'), 'utf8', (err, data) => {
    if (err) return res.status(404).send('Camera 2 page not found');
    res.type('html').send(data);
  });
});

// Stop analysis if port is shut down
function stopBackgroundAnalysis() {
  if (analysisInterval1) {
    clearInterval(analysisInterval1);
  }
  if (analysisInterval2) {
    clearInterval(analysisInterval2);
  }
  if (camera1SmsAlertInterval) {
    clearInterval(camera1SmsAlertInterval);
  }
  console.log('Background analysis stopped');
}

app.listen(port, () => {
  console.log(`Testing GrayVMS streamer running on http://localhost:${port}`);
  if (useTestPattern) console.log('Using test pattern (TEST_PATTERN=1)');
  else if (!rtsp) console.log(`Using local device: ${device} (set RTSP_URL to stream from RTSP)`);
  initAnalyticsDb();
  
  // Start background analysis task
  startBackgroundAnalysis();
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  stopBackgroundAnalysis();
  closeAnalyticsDb();
  process.exit(0);
});
