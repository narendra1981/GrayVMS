# Testing_GrayVMS — MJPEG Streamer

This small example serves a live MJPEG stream using `ffmpeg` and a Node.js Express server.

Prerequisites:
- `node` (>=14) and `npm`
- `ffmpeg` installed on the host
- A local video device (e.g. `/dev/video0`) or an `RTSP_URL` to stream from

Install and run:

```bash
cd "Somatics/Source_Local_Copied/Integration_ GrayVMS/Testing_GrayVMS"
npm install
# Local webcam
npm start

# Or stream from RTSP
RTSP_URL="rtsp://user:pass@camera:554/stream" npm start
```

Open http://localhost:3000 in a browser. The page will now prefer a stored MP4 file (`/video.mp4`) displayed with an HTML5 `<video>` element and falls back to the MJPEG `/stream` endpoint.

To use a stored video:

```bash
# Put a file named video.mp4 in the `public/` folder, then:
npm start

# Or set a custom path:
VIDEO_FILE="/full/path/to/your-file.mp4" npm start
```

To continue using live capture, use the existing env vars (`RTSP_URL`, `VIDEO_DEVICE`) or `TEST_PATTERN=1`.
