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
  // then a project-root `output_2min.avi` if present, then `public/video.mp4`.
  if (envVideoFile) return path.isAbsolute(envVideoFile) ? envVideoFile : path.join(__dirname, envVideoFile);
  const candidateRoot = path.join(__dirname, 'output_2min.avi');
  if (fs.existsSync(candidateRoot)) return candidateRoot;
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
        font-family: Inter, system-ui, Arial, sans-serif;
        margin: 0;
        padding: 1.25rem;
        background: radial-gradient(circle at top, #2b2b2b 0%, #111111 45%, #090909 100%);
        color: #f2ece6;
      }
      h1 {
        margin: 0 0 1rem;
        font-size: 1.6rem;
        letter-spacing: 0.02em;
        color: #e4d8ca;
      }
      .content {
        display: flex;
        gap: 1.25rem;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .video-panel, .analytics {
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 10px 30px rgba(0,0,0,0.35);
        border-radius: 14px;
        backdrop-filter: blur(10px);
      }
      .video-panel {
        flex: 1 1 560px;
        padding: 0.8rem;
        background: rgba(20, 20, 20, 0.92);
      }
      .stream {
        width: min(60vw, 760px);
        max-width: 100%;
        height: auto;
        display: block;
        border-radius: 10px;
        background: #000;
      }
      .analytics {
        flex: 1 1 360px;
        padding: 0.95rem 1rem;
        background: linear-gradient(145deg, #181717 0%, #2b211d 100%);
        max-width: 500px;
      }
      .analytics h2 { margin: 0 0 0.6rem; font-size: 1.15rem; color: #c9a98a; }
      .analytics p { margin: 0.28rem 0; font-size: 0.95rem; }
      .analytics strong { display: inline-block; min-width: 150px; color: #d0c2b7; }
      .json-box {
        margin-top: 0.8rem;
        padding: 0.75rem;
        background: rgba(6, 6, 6, 0.95);
        color: #e5d8c9;
        border-radius: 8px;
        overflow-x: auto;
        font-size: 0.9rem;
        white-space: pre-wrap;
        border: 1px solid rgba(201, 169, 138, 0.16);
      }
    </style>
  </head>
  <body>
    <h1>GrayVMS Live View</h1>
    <div class="content">
      <div class="video-panel">
        <video class="stream" controls autoplay loop muted playsinline src="/video.mp4"></video>
      </div>
      <div class="analytics">
        <h2>Person Analytics</h2>
        <p><strong>Video:</strong> <span id="analytics-video">Loading...</span></p>
        <p><strong>Frames analyzed:</strong> <span id="analytics-sampled">-</span></p>
        <p><strong>Max people:</strong> <span id="analytics-max">-</span></p>
        <p><strong>Average people:</strong> <span id="analytics-average">-</span></p>
        <p><strong>Min people:</strong> <span id="analytics-min">-</span></p>
        <div class="json-box" id="analytics-json">Loading JSON data...</div>
      </div>
    </div>
    <script>
      async function refreshAnalytics() {
        try {
          const res = await fetch('/analytics/person_counts.json');
          if (!res.ok) return;
          const data = await res.json();
          document.getElementById('analytics-video').textContent = data.video || 'N/A';
          document.getElementById('analytics-sampled').textContent = data.sampled_frames ?? '-';
          document.getElementById('analytics-max').textContent = data.max_people ?? '-';
          document.getElementById('analytics-average').textContent = data.average_people ?? '-';
          document.getElementById('analytics-min').textContent = data.min_people ?? '-';
          document.getElementById('analytics-json').textContent = JSON.stringify(data, null, 2);
        } catch (e) {
          document.getElementById('analytics-json').textContent = 'Analytics unavailable';
        }
      }
      refreshAnalytics();
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

app.get('/', (req, res) => res.type('html').send(dashboardHtml));

app.listen(port, () => {
  console.log(`Testing GrayVMS streamer running on http://localhost:${port}`);
  if (useTestPattern) console.log('Using test pattern (TEST_PATTERN=1)');
  else if (!rtsp) console.log(`Using local device: ${device} (set RTSP_URL to stream from RTSP)`);
});
