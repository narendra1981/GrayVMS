const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;
const rtsp = process.env.RTSP_URL || '';
const device = process.env.VIDEO_DEVICE || '/dev/video0';
const useTestPattern = process.env.TEST_PATTERN === '1';
const envVideoFile = process.env.VIDEO_FILE;
const videoFileDefault = 'video.mp4'; // fallback filename in public/

function resolvePreferredVideo() {
  // Priority: explicit env VIDEO_FILE (absolute or relative to project root),
  // then browser-friendly project-root videos (mp4/webm/ogg),
  // then legacy AVI, then `public/video.mp4`.
  if (envVideoFile) return path.isAbsolute(envVideoFile) ? envVideoFile : path.join(__dirname, envVideoFile);

  const playableCandidates = [
    path.join(__dirname, 'video.mp4'),
    path.join(__dirname, 'Test.mp4'),
    path.join(__dirname, 'Test_1.mp4'),
    path.join(__dirname, 'July_07.mp4'),
    path.join(__dirname, 'video_1.mp4'),
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
        padding: 2rem;
        background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 25%, #2d2d2d 50%, #1a1a1a 75%, #0a0a0a 100%);
        color: #e8e8e8;
        min-height: 100vh;
      }
      h1 {
        margin: 0 0 2rem;
        font-size: 2.2rem;
        letter-spacing: 0.05em;
        color: #d4af37;
        text-shadow: 0 2px 10px rgba(212, 175, 55, 0.3);
        font-weight: 700;
      }
      .container {
        max-width: 1400px;
        margin: 0 auto;
      }
      .content {
        display: flex;
        gap: 2rem;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .video-panel {
        flex: 1 1 560px;
        min-width: 300px;
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
      .analytics-section {
        flex: 1 1 380px;
        min-width: 300px;
      }
      .analytics-title {
        font-size: 1.4rem;
        color: #d4af37;
        margin: 0 0 1.5rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .stats-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1rem;
        margin-bottom: 1.5rem;
      }
      .stat-box {
        background: linear-gradient(135deg, #1f1f1f 0%, #2a2a2a 100%);
        border: 1.5px solid #d4af37;
        border-radius: 10px;
        padding: 1rem;
        text-align: center;
        transition: all 0.3s ease;
        box-shadow: 0 4px 15px rgba(212, 175, 55, 0.1);
        position: relative;
        overflow: hidden;
      }
      .stat-box::before {
        content: '';
        position: absolute;
        top: 0;
        left: -100%;
        width: 100%;
        height: 100%;
        background: linear-gradient(90deg, transparent, rgba(212, 175, 55, 0.1), transparent);
        transition: left 0.5s;
      }
      .stat-box:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 20px rgba(212, 175, 55, 0.2);
        border-color: #f0d46f;
      }
      .stat-label {
        font-size: 0.85rem;
        color: #999;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 0.5rem;
        font-weight: 500;
      }
      .stat-value {
        font-size: 2rem;
        color: #d4af37;
        font-weight: 700;
        font-family: 'Courier New', monospace;
      }
      .info-box {
        background: linear-gradient(135deg, #1f1f1f 0%, #2a2a2a 100%);
        border: 1.5px solid #d4af37;
        border-radius: 10px;
        padding: 1rem;
        margin-bottom: 1rem;
      }
      .info-label {
        font-size: 0.9rem;
        color: #999;
        margin-bottom: 0.3rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .info-value {
        font-size: 1rem;
        color: #e8e8e8;
        word-break: break-all;
        font-family: 'Courier New', monospace;
      }
      .json-box {
        margin-top: 1rem;
        padding: 1rem;
        background: rgba(15, 15, 15, 0.8);
        color: #b0b0b0;
        border-radius: 8px;
        overflow-x: auto;
        font-size: 0.8rem;
        white-space: pre-wrap;
        border: 1px solid #d4af37;
        max-height: 300px;
        overflow-y: auto;
        font-family: 'Courier New', monospace;
      }
      @media (max-width: 768px) {
        h1 { font-size: 1.8rem; }
        .content { flex-direction: column; gap: 1.5rem; }
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
            <video class="stream" controls autoplay loop muted playsinline src="/video.mp4"></video>
          </div>
        </div>
        <div class="analytics-section">
          <div class="analytics-title">📊 Person Analytics</div>
          <div class="info-box">
            <div class="info-label">Video File</div>
            <div class="info-value" id="analytics-video">Loading...</div>
          </div>
          <div style="color: #d4af37; font-size: 0.9rem; margin-bottom: 0.8rem; font-weight: 600;">👤 People Detection</div>
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
          <div style="color: #d4af37; font-size: 0.9rem; margin-bottom: 0.8rem; margin-top: 1.2rem; font-weight: 600;">🎯 Object Detection</div>
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
          <div style="color: #d4af37; font-size: 0.9rem; margin-bottom: 0.8rem; margin-top: 1.2rem; font-weight: 600;">� Crowd Analysis</div>
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
          </div>
          <div style="color: #d4af37; font-size: 0.9rem; margin-bottom: 0.8rem; margin-top: 1.2rem; font-weight: 600;">📊 Density Analysis</div>
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
          <div style="color: #d4af37; font-size: 0.9rem; margin-bottom: 0.8rem; margin-top: 1.2rem; font-weight: 600;">�🔍 Motion Analysis</div>
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
          <div class="panel-box">
            <div style="color: #d4af37; font-size: 0.9rem; margin-bottom: 0.5rem; font-weight: 600;">Raw Data</div>
            <div class="json-box" id="analytics-json">Loading JSON data...</div>
          </div>
        </div>
      </div>
    </div>
    <script>
      async function refreshAnalytics() {
        try {
          const res = await fetch('/analytics/person_counts.json');
          if (!res.ok) return;
          const data = await res.json();
          
          // Video info
          document.getElementById('analytics-video').textContent = data.video || 'N/A';
          
          // People detection
          document.getElementById('analytics-sampled').textContent = data.sampled_frames ?? '-';
          document.getElementById('analytics-max').textContent = data.max_people ?? '-';
          document.getElementById('analytics-average').textContent = data.average_people ?? '-';
          document.getElementById('analytics-min').textContent = data.min_people ?? '-';
          
          // Object detection
          document.getElementById('analytics-max-objects').textContent = data.max_objects ?? '-';
          document.getElementById('analytics-avg-objects').textContent = data.average_objects ?? '-';
          document.getElementById('analytics-min-objects').textContent = data.min_objects ?? '-';
          document.getElementById('analytics-motion-percent').textContent = (data.motion_percentage ?? 0) + '%';
          
          // Crowd analysis
          const crowdAnalysis = data.crowd_analysis || {};
          document.getElementById('analytics-crowd-frames').textContent = crowdAnalysis.total_crowd_frames ?? '-';
          document.getElementById('analytics-crowd-percent').textContent = (crowdAnalysis.crowd_percentage ?? 0) + '%';
          document.getElementById('analytics-max-crowd').textContent = crowdAnalysis.max_crowd_size ?? '-';
          document.getElementById('analytics-avg-crowd').textContent = crowdAnalysis.average_crowd_size ?? '-';
          
          // Density analysis
          const densityAnalysis = data.density_analysis || {};
          document.getElementById('analytics-max-density').textContent = (densityAnalysis.max_density ?? 0) + '%';
          document.getElementById('analytics-avg-density').textContent = (densityAnalysis.average_density ?? 0) + '%';
          
          // Motion analysis
          document.getElementById('analytics-motion-frames').textContent = data.frames_with_motion ?? '-';
          document.getElementById('analytics-duration').textContent = (data.duration_seconds ?? 0) + 's';
          document.getElementById('analytics-fps').textContent = data.fps ?? '-';
          document.getElementById('analytics-frame-count').textContent = data.frame_count ?? '-';
          
          document.getElementById('analytics-json').textContent = JSON.stringify(data, null, 2);
        } catch (e) {
          document.getElementById('analytics-json').textContent = 'Analytics unavailable: ' + e.message;
        }
      }
      refreshAnalytics();
      setInterval(refreshAnalytics, 5000);
    </script>
  </body>
</html>`;

app.get('/', (req, res) => res.type('html').send(dashboardHtml));

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
  const filePath = resolvePreferredVideo();
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

// Provide info about which file is being served
app.get('/video-info', (req, res) => {
  const filePath = resolvePreferredVideo();
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

// Background analysis task - runs Python analytics periodically
function runAnalysisTask() {
  const videoPath = resolvePreferredVideo();
  const outputPath = path.join(__dirname, 'analytics', 'person_counts.json');
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
    console.error('Analysis error:', err.message);
  });
}

// Manual endpoint to trigger analysis
app.get('/analyze', (req, res) => {
  runAnalysisTask();
  res.json({ status: 'Analysis started' });
});

// Start background analysis every 5 seconds
let analysisInterval = null;
function startBackgroundAnalysis() {
  // Run initial analysis immediately
  runAnalysisTask();
  
  // Then run every 5 seconds
  analysisInterval = setInterval(runAnalysisTask, 5000);
  console.log('Background analysis started (running every 5 seconds)');
}

app.get('/', (req, res) => res.type('html').send(dashboardHtml));

// Stop analysis if port is shut down
function stopBackgroundAnalysis() {
  if (analysisInterval) {
    clearInterval(analysisInterval);
    console.log('Background analysis stopped');
  }
}

app.listen(port, () => {
  console.log(`Testing GrayVMS streamer running on http://localhost:${port}`);
  if (useTestPattern) console.log('Using test pattern (TEST_PATTERN=1)');
  else if (!rtsp) console.log(`Using local device: ${device} (set RTSP_URL to stream from RTSP)`);
  
  // Start background analysis task
  startBackgroundAnalysis();
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  stopBackgroundAnalysis();
  process.exit(0);
});
