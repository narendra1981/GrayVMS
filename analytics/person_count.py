import json
import os
import sys
from pathlib import Path
from typing import List, Dict, Any

import cv2
import numpy as np
from ultralytics import YOLO


DEFAULT_MODEL = "yolov8n.pt"
DEFAULT_INPUT = "video.mp4"
DEFAULT_OUTPUT = "analytics/person_counts.json"


def detect_motion(frame: np.ndarray, prev_frame: np.ndarray = None, threshold: int = 30) -> bool:
    """Detect if there is significant motion between frames"""
    if prev_frame is None:
        return False
    
    try:
        # Convert to grayscale
        gray_curr = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray_prev = cv2.cvtColor(prev_frame, cv2.COLOR_BGR2GRAY)
        
        # Calculate absolute difference
        diff = cv2.absdiff(gray_curr, gray_prev)
        
        # Threshold the difference
        _, thresh = cv2.threshold(diff, threshold, 255, cv2.THRESH_BINARY)
        
        # Count pixels that changed
        motion_pixels = np.count_nonzero(thresh)
        frame_area = thresh.shape[0] * thresh.shape[1]
        motion_percentage = (motion_pixels / frame_area) * 100
        
        # Consider it motion if more than 1% of frame changed
        return motion_percentage > 1.0
    except:
        return False


def analyze_video(input_path: str, output_path: str, model_name: str = DEFAULT_MODEL) -> Dict[str, Any]:
    input_path = str(Path(input_path).resolve())
    output_path = str(Path(output_path).resolve())

    model = YOLO(model_name)
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Could not open video: {input_path}")

    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 1
    total_seconds = frame_count / fps if fps else 0

    counts: List[Dict[str, Any]] = []
    prev_frame = None
    frame_idx = 0
    
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        # Analyze EVERY frame for maximum person detection accuracy
        results = model(frame, stream=False, verbose=False)
        persons = 0
        total_objects = 0
        object_counts = {}
        
        for result in results:
            boxes = result.boxes
            if boxes is None:
                continue
            for box in boxes:
                cls = int(box.cls[0]) if hasattr(box, 'cls') and len(box.cls) > 0 else None
                if cls is None:
                    continue
                
                obj_name = result.names.get(cls, 'unknown')
                total_objects += 1
                
                # Count each object type
                if obj_name not in object_counts:
                    object_counts[obj_name] = 0
                object_counts[obj_name] += 1
                
                # Count persons specifically
                if obj_name == 'person':
                    persons += 1
        
        # Detect motion between frames
        motion_detected = bool(detect_motion(frame, prev_frame))  # Convert to Python bool
        
        counts.append({
            "frame": frame_idx,
            "timestamp_seconds": round(frame_idx / fps, 2) if fps else 0,
            "person_count": persons,
            "total_objects": total_objects,
            "object_types": object_counts,
            "motion_detected": motion_detected,
        })
        
        prev_frame = frame.copy()
        
        frame_idx += 1

    cap.release()
    
    # Calculate moving objects count (frames where motion was detected)
    moving_frames = sum(1 for item in counts if item.get("motion_detected", False))
    
    summary = {
        "video": os.path.basename(input_path),
        "frame_count": frame_count,
        "duration_seconds": round(total_seconds, 2),
        "fps": round(fps, 2),
        "sampled_frames": len(counts),
        "person_counts": counts,
        "max_people": max((item["person_count"] for item in counts), default=0),
        "min_people": min((item["person_count"] for item in counts), default=0),
        "average_people": round(sum(item["person_count"] for item in counts) / len(counts), 2) if counts else 0,
        "max_objects": max((item["total_objects"] for item in counts), default=0),
        "min_objects": min((item["total_objects"] for item in counts), default=0),
        "average_objects": round(sum(item["total_objects"] for item in counts) / len(counts), 2) if counts else 0,
        "frames_with_motion": moving_frames,
        "motion_percentage": round((moving_frames / len(counts) * 100), 2) if counts else 0,
    }

    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as fh:
        json.dump(summary, fh, indent=2)

    return summary


if __name__ == "__main__":
    input_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_INPUT
    output_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUTPUT
    model_path = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_MODEL
    summary = analyze_video(input_path, output_path, model_path)
    print(json.dumps({
        "saved_to": output_path,
        "max_people": summary["max_people"],
        "average_people": summary["average_people"],
        "sampled_frames": summary["sampled_frames"],
    }, indent=2))
