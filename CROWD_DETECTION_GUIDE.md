# Testing_GrayVMS - Enhanced Analytics with Crowd Detection

## Overview

The Testing_GrayVMS project has been updated with an advanced crowd counting mechanism that provides significantly better accuracy for detecting and counting people, especially in crowded scenes.

## Key Improvements

### 1. **Density-Based Crowd Detection**
- Calculates the percentage of frame area occupied by people
- Detects when density exceeds thresholds indicating a crowd
- Uses spatial clustering to identify tightly grouped people

### 2. **Adaptive Confidence Thresholds**
- In crowded scenes, confidence thresholds are automatically lowered
- This allows detection of partially occluded or lower-confidence people
- Baseline: 0.5, reduces to 0.2 in progressively crowded scenes

### 3. **Improved Non-Maximum Suppression (NMS)**
- Enhanced IoU-based deduplication algorithm
- More aggressive in crowded scenes (IoU threshold: 0.25 vs 0.3)
- Prevents counting the same person multiple times

### 4. **Centroid-Based Spatial Analysis**
- Calculates centroids of detected bounding boxes
- Measures average distance between people
- Identifies spatial clustering patterns

### 5. **Comprehensive Crowd Metrics**
Outputs include:
- **Crowd Analysis**: Crowd frames count, percentage, max/average crowd size
- **Density Analysis**: Maximum and average frame density percentage
- **Enhanced Frame Data**: Per-frame crowd size, density, and crowd detection flag

## New Analytics Output Fields

### Crowd Analysis
```json
"crowd_analysis": {
  "total_crowd_frames": 45,
  "crowd_percentage": 12.5,
  "max_crowd_size": 28,
  "average_crowd_size": 18.3,
  "frames_with_crowds": 45
}
```

### Density Analysis
```json
"density_analysis": {
  "max_density": 35.2,
  "average_density": 18.7
}
```

### Per-Frame Data
Each frame now includes:
- `crowd_density`: Percentage of frame occupied (0-100%)
- `is_crowd`: Boolean flag if frame contains a crowd
- `crowd_size`: Number of people if crowd detected

## Dashboard Updates

The web dashboard now displays:
- **👥 Crowd Analysis** section showing crowd statistics
- **📊 Density Analysis** section with max/average density metrics
- Real-time updates of all crowd metrics every 5 seconds

## Configuration Parameters

Edit the parameters in `analytics/person_count.py`:

```python
CROWD_DENSITY_THRESHOLD = 0.15      # Density % threshold for crowd (0-100)
CENTROID_DISTANCE_THRESHOLD = 50    # Pixel distance for clustering
TEMPORAL_WINDOW = 5                 # Frames for temporal consistency
```

## Installation & Setup

### 1. Install Python Dependencies
```bash
cd Testing_GrayVMS
pip install -r requirements.txt
```

### 2. Install Node.js Dependencies
```bash
npm install
```

### 3. Start the Server
```bash
npm start
```

### 4. Access Dashboard
Open `http://localhost:3000` in your browser

## Running Analysis

### Automatic (Background)
Analysis runs every 5 seconds automatically and updates the dashboard.

### Manual Trigger
```bash
curl http://localhost:3000/analyze
```

### Direct Python Execution
```bash
python3 analytics/person_count.py <video_path> <output_json> <model_path>
```

Example:
```bash
python3 analytics/person_count.py video.mp4 analytics/person_counts.json yolov8n.pt
```

## Supported Video Formats
- MP4 (.mp4)
- AVI (.avi)
- WebM (.webm)
- OGV (.ogv)

## Performance Notes

- **YOLOv8n** (nano): Fast, recommended for real-time
- **YOLOv8s** (small): Better accuracy
- **YOLOv8m** (medium): High accuracy, slower
- **YOLOv8l** (large): Highest accuracy, slowest

## API Endpoints

- `GET /` - Dashboard page
- `GET /video.mp4` - Serve video file with range support
- `GET /stream` - MJPEG stream (fallback)
- `GET /video-info` - Get video file information
- `GET /analytics/person_counts.json` - Get current analytics JSON
- `GET /analyze` - Manually trigger analysis

## Environment Variables

- `PORT` - Server port (default: 3000)
- `RTSP_URL` - RTSP stream URL (e.g., `rtsp://camera:554/stream`)
- `VIDEO_DEVICE` - Local video device (default: `/dev/video0`)
- `VIDEO_FILE` - Custom video file path
- `TEST_PATTERN` - Use test pattern instead of video (set to `1`)

Example:
```bash
RTSP_URL="rtsp://user:pass@camera:554/stream" npm start
```

## Algorithm Details

### Crowd Detection Process
1. Run YOLOv8 detection at multiple confidence thresholds (0.5, 0.4, 0.3, 0.2)
2. Extract all person bounding boxes
3. Calculate total area occupied and frame density
4. Compute centroids and average inter-centroid distance
5. Flag as crowd if: density > 15% AND average distance < 50 pixels AND >= 5 people
6. Apply adaptive NMS with stricter thresholds in crowded scenes

### Density Calculation
```
Density % = (Sum of all bounding box areas / Frame area) * 100
```

### Crowd Confidence
Based on density percentage with cap at 100%

## Troubleshooting

### Analytics not updating
- Check that Python 3.7+ is installed
- Verify dependencies: `pip list | grep -E "opencv|ultralytics|scipy|torch"`
- Check browser console for JavaScript errors
- Ensure video file exists and is readable

### Slow performance
- Use a smaller YOLOv8 model (nano/small instead of large)
- Reduce video resolution
- Increase refresh interval in dashboard

### High false positives
- Increase `CROWD_DENSITY_THRESHOLD` (0.2-0.3)
- Increase `CENTROID_DISTANCE_THRESHOLD` (60-80)
- Use a larger YOLOv8 model

## File Structure

```
Testing_GrayVMS/
├── server.js                 # Express server & dashboard
├── package.json             # Node dependencies
├── requirements.txt         # Python dependencies
├── public/                  # Static files
├── analytics/
│   ├── person_count.py      # Enhanced detection script
│   └── person_counts.json   # Output analytics
└── *.mp4, *.avi            # Test video files
```

## Performance Benchmarks

Typical performance on a single GPU:
- **YOLOv8n**: 40-60 FPS
- **YOLOv8s**: 25-40 FPS
- **YOLOv8m**: 15-25 FPS
- **YOLOv8l**: 10-15 FPS

## Future Enhancements

- [ ] Temporal tracking across frames
- [ ] Region-based analysis (heatmaps)
- [ ] Object trajectory visualization
- [ ] Alert system for crowd thresholds
- [ ] Export reports (PDF/CSV)
- [ ] Multi-camera support
- [ ] GPU acceleration options
