import json
import os
import sys
from pathlib import Path
from typing import List, Dict, Any

import cv2
from ultralytics import YOLO


DEFAULT_MODEL = "yolov8n.pt"
DEFAULT_INPUT = "video.mp4"
DEFAULT_OUTPUT = "analytics/person_counts.json"


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
    frame_idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        if frame_idx % max(1, int(fps // 2)) == 0:
            results = model(frame, stream=False, verbose=False)
            persons = 0
            for result in results:
                boxes = result.boxes
                if boxes is None:
                    continue
                for box in boxes:
                    cls = int(box.cls[0]) if hasattr(box, 'cls') and len(box.cls) > 0 else None
                    if cls is None:
                        continue
                    if result.names.get(cls, '') == 'person':
                        persons += 1
            counts.append({
                "frame": frame_idx,
                "timestamp_seconds": round(frame_idx / fps, 2) if fps else 0,
                "person_count": persons,
            })
        frame_idx += 1

    cap.release()

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
    }

    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as fh:
        json.dump(summary, fh, indent=2)

    return summary


if __name__ == "__main__":
    input_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_INPUT
    output_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUTPUT
    summary = analyze_video(input_path, output_path)
    print(json.dumps({
        "saved_to": output_path,
        "max_people": summary["max_people"],
        "average_people": summary["average_people"],
        "sampled_frames": summary["sampled_frames"],
    }, indent=2))
