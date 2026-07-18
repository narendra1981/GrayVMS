# Testing_GrayVMS — MJPEG Streamer

This small example serves a live MJPEG stream using `ffmpeg` and a Node.js Express server.

Prerequisites:
- `node` (>=14) and `npm`
- `ffmpeg` installed on the host
- A local video device (e.g. `/dev/video0`) or an `RTSP_URL` to stream from

Install and run:

```bash
cd "Testing_GrayVMS"
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

## Camera 1 SMS Alerts (Mobile)

Camera 1 alerts are active when `max_people > 10` by default. The dashboard alert remains enabled, and you can also send SMS and WhatsApp alerts to mobile numbers via Twilio.

Install dependencies:

```bash
npm install
```

Create env file and edit values:

```bash
cp .env.example .env
```

Then run:

```bash
npm run start:sms
```

Optional inline run (without .env file):

```bash
CAMERA1_MAX_PEOPLE_ALERT_THRESHOLD=10 \
TWILIO_ACCOUNT_SID="your_sid" \
TWILIO_AUTH_TOKEN="your_token" \
TWILIO_FROM_NUMBER="+1234567890" \
TWILIO_TO_NUMBERS="+1111111111,+2222222222" \
SMS_ALERT_COOLDOWN_SECONDS=300 \
npm start
```

Notes:
- `TWILIO_TO_NUMBERS` supports one or more comma-separated mobile numbers.
- WhatsApp alerts use `TWILIO_WHATSAPP_FROM` and `TWILIO_WHATSAPP_TO_NUMBERS`.
- For Twilio sandbox, `TWILIO_WHATSAPP_FROM` is typically `whatsapp:+14155238886`.
- SMS sends when alert becomes active, then repeats only after cooldown if still active.
- WhatsApp follows the same trigger and cooldown behavior as SMS.
- Current alert state is available at `/alerts/camera1/current`.
- Channel readiness status is available at `/alerts/channels/status`.
