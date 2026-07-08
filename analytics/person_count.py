import json
import os
import sys
from pathlib import Path
from typing import List, Dict, Any, Tuple


class _NumpyEncoder(json.JSONEncoder):
    """JSON encoder that converts numpy scalar types to native Python types."""
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)

from scipy.spatial.distance import cdist

import cv2
import numpy as np
from ultralytics import YOLO


DEFAULT_MODEL = "yolov8n.pt"
DEFAULT_INPUT = "video.mp4"
DEFAULT_OUTPUT = "analytics/person_counts.json"
DEFAULT_CONFIDENCE = 0.35
DEFAULT_IMGSZ = 416
DEFAULT_FRAME_STRIDE = 2

# Crowd detection parameters
CROWD_DENSITY_THRESHOLD = 0.15  # If density > 15%, consider it a crowd
CENTROID_DISTANCE_THRESHOLD = 50  # pixels, for tracking consistency
TEMPORAL_WINDOW = 5  # frames to consider for temporal consistency


def normalize_model_name(model_name: str) -> str:
    """Map shorthand model names to concrete Ultralytics weights."""
    model_name = (model_name or "").strip()
    if model_name in {"yolov8", "yolov8.pt"}:
        return "yolov8n.pt"
    return model_name or DEFAULT_MODEL



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


def calculate_centroid(box: np.ndarray) -> Tuple[float, float]:
    """Calculate centroid of a bounding box"""
    x1, y1, x2, y2 = box
    cx = (x1 + x2) / 2
    cy = (y1 + y2) / 2
    return cx, cy


def calculate_box_area(box: np.ndarray) -> float:
    """Calculate area of a bounding box"""
    x1, y1, x2, y2 = box
    return (x2 - x1) * (y2 - y1)


def calculate_iou(box1: np.ndarray, box2: np.ndarray) -> float:
    """Calculate Intersection over Union (IoU) between two boxes"""
    x1_min, y1_min, x1_max, y1_max = box1
    x2_min, y2_min, x2_max, y2_max = box2
    
    inter_x_min = max(x1_min, x2_min)
    inter_y_min = max(y1_min, y2_min)
    inter_x_max = min(x1_max, x2_max)
    inter_y_max = min(y1_max, y2_max)
    
    if inter_x_max > inter_x_min and inter_y_max > inter_y_min:
        inter_area = (inter_x_max - inter_x_min) * (inter_y_max - inter_y_min)
        box1_area = (x1_max - x1_min) * (y1_max - y1_min)
        box2_area = (x2_max - x2_min) * (y2_max - y2_min)
        union_area = box1_area + box2_area - inter_area
        return inter_area / union_area if union_area > 0 else 0
    return 0


def detect_crowd_density(boxes: List[np.ndarray], frame_shape: Tuple[int, int]) -> Tuple[float, bool]:
    """
    Detect crowd density and return density percentage and crowd flag.
    Uses clustering to find dense regions.
    """
    if len(boxes) < 3:
        return 0.0, False
    
    frame_height, frame_width = frame_shape[:2]
    frame_area = frame_height * frame_width
    total_box_area = sum(calculate_box_area(box) for box in boxes)
    density = (total_box_area / frame_area) * 100
    
    # Check spatial clustering - if people are grouped tightly
    is_crowd = False
    if len(boxes) >= 5:
        centroids = np.array([calculate_centroid(box) for box in boxes])
        # Calculate average distance between centroids
        if len(centroids) > 1:
            distances = cdist(centroids, centroids).flatten()
            distances = distances[distances > 0]
            avg_distance = np.mean(distances) if len(distances) > 0 else 100
            # If people are close together on average, it's a crowd
            is_crowd = avg_distance < CENTROID_DISTANCE_THRESHOLD and density > CROWD_DENSITY_THRESHOLD
    
    return density, is_crowd


def count_persons_with_crowd_detection(
    model,
    frame,
    conf_threshold: float = DEFAULT_CONFIDENCE,
    imgsz: int = DEFAULT_IMGSZ,
    use_half: bool = False,
) -> Tuple[int, int, Dict, Dict]:
    """
    Run detection with crowd-aware algorithms for better counting accuracy.
    
    Returns:
        - person_count: number of people
        - total_objects: total detectable objects
        - object_counts: breakdown by object type
        - crowd_info: crowd metrics
    """
    all_boxes = []

    # Single-pass inference is significantly faster than multi-threshold passes.
    results = model.predict(
        frame,
        conf=conf_threshold,
        imgsz=imgsz,
        half=use_half,
        stream=False,
        verbose=False,
    )
    for result in results:
        if result.boxes is None:
            continue
        for box in result.boxes:
            xyxy = box.xyxy[0].cpu().numpy() if hasattr(box.xyxy[0], "cpu") else box.xyxy[0]
            cls = int(box.cls[0]) if hasattr(box, "cls") and len(box.cls) > 0 else None
            if cls is None:
                continue

            all_boxes.append(
                {
                    "box": xyxy,
                    "cls": cls,
                    "conf": float(box.conf[0]) if hasattr(box, "conf") else 0.0,
                    "names": result.names,
                }
            )
    
    if not all_boxes:
        return 0, 0, {}, {'density': 0.0, 'is_crowd': False, 'crowd_size': 0}
    
    # Extract person boxes for crowd analysis
    person_boxes = [item['box'] for item in all_boxes if item['names'].get(item['cls']) == 'person']
    
    # Analyze crowd density
    density, is_crowd = detect_crowd_density(person_boxes, frame.shape)
    
    # Group by class
    class_boxes = {}
    for item in all_boxes:
        cls = item['cls']
        if cls not in class_boxes:
            class_boxes[cls] = []
        class_boxes[cls].append(item)
    
    # Ultralytics already applies NMS internally, so keep class counting simple.
    persons = 0
    total_objects = 0
    object_counts = {}
    
    for cls_id, boxes in class_boxes.items():
        for box_data in boxes:
            total_objects += 1
            obj_name = box_data["names"].get(cls_id, "unknown")
            if obj_name not in object_counts:
                object_counts[obj_name] = 0
            object_counts[obj_name] += 1

            if obj_name == "person":
                persons += 1
    
    # Crowd-specific metrics
    crowd_info = {
        'density': round(density, 2),
        'is_crowd': bool(is_crowd),
        'crowd_size': persons if is_crowd else 0,
        'crowd_confidence': round(density / 100 if is_crowd else 0, 2)  # 0-1 confidence in crowd detection
    }
    
    return persons, total_objects, object_counts, crowd_info



def analyze_video(input_path: str, output_path: str, model_name: str = DEFAULT_MODEL) -> Dict[str, Any]:
    input_path = str(Path(input_path).resolve())
    output_path = str(Path(output_path).resolve())

    normalized_model = normalize_model_name(model_name)
    model = YOLO(normalized_model)
    use_half = str(getattr(model, "device", "")).startswith("cuda")
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Could not open video: {input_path}")

    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 1
    total_seconds = frame_count / fps if fps else 0

    counts: List[Dict[str, Any]] = []
    prev_frame = None
    source_frame_idx = 0
    crowd_frames = 0
    max_crowd_size = 0
    all_crowd_sizes = []
    object_totals: Dict[str, int] = {}
    object_type_diversity: List[int] = []
    
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        if source_frame_idx % DEFAULT_FRAME_STRIDE != 0:
            source_frame_idx += 1
            continue

        # Analyze with enhanced crowd detection
        persons, total_objects, object_counts, crowd_info = count_persons_with_crowd_detection(
            model,
            frame,
            conf_threshold=DEFAULT_CONFIDENCE,
            imgsz=DEFAULT_IMGSZ,
            use_half=use_half,
        )
        
        # Detect motion between frames
        motion_detected = bool(detect_motion(frame, prev_frame))
        
        # Track crowd statistics
        if crowd_info['is_crowd']:
            crowd_frames += 1
            crowd_size = crowd_info['crowd_size']
            all_crowd_sizes.append(crowd_size)
            max_crowd_size = max(max_crowd_size, crowd_size)

        for obj_name, count in object_counts.items():
            object_totals[obj_name] = object_totals.get(obj_name, 0) + int(count)

        object_type_count = len([name for name, count in object_counts.items() if count > 0])
        object_type_diversity.append(object_type_count)

        prev_people = counts[-1]["person_count"] if counts else persons
        people_delta = persons - prev_people
        
        counts.append({
            "frame": source_frame_idx,
            "timestamp_seconds": round(source_frame_idx / fps, 2) if fps else 0,
            "person_count": persons,
            "people_delta": people_delta,
            "total_objects": total_objects,
            "object_types": object_counts,
            "object_type_diversity": object_type_count,
            "motion_detected": motion_detected,
            "crowd_density": crowd_info['density'],
            "is_crowd": crowd_info['is_crowd'],
            "crowd_size": crowd_info['crowd_size'],
        })
        
        prev_frame = frame.copy()
        source_frame_idx += 1

    cap.release()
    
    # Calculate statistics
    moving_frames = sum(1 for item in counts if item.get("motion_detected", False))
    avg_crowd_size = np.mean(all_crowd_sizes) if all_crowd_sizes else 0
    person_series = [item["person_count"] for item in counts]
    density_series = [item.get("crowd_density", 0) for item in counts]
    people_deltas = [abs(item.get("people_delta", 0)) for item in counts[1:]]

    def _trend_direction(slope: float, epsilon: float = 0.03) -> str:
        if slope > epsilon:
            return "rising"
        if slope < -epsilon:
            return "falling"
        return "stable"

    crowd_event_count = 0
    longest_crowd_event = 0
    current_event = 0
    for item in counts:
        if item.get("is_crowd"):
            current_event += 1
            if current_event == 1:
                crowd_event_count += 1
        else:
            longest_crowd_event = max(longest_crowd_event, current_event)
            current_event = 0
    longest_crowd_event = max(longest_crowd_event, current_event)

    max_people = max(person_series, default=0)
    peak_frames = [item for item in counts if item.get("person_count", 0) == max_people]
    peak_time = peak_frames[0].get("timestamp_seconds", 0) if peak_frames else 0

    people_slope = float(np.polyfit(np.arange(len(person_series)), person_series, 1)[0]) if len(person_series) >= 2 else 0.0
    density_slope = float(np.polyfit(np.arange(len(density_series)), density_series, 1)[0]) if len(density_series) >= 2 else 0.0

    top_objects = sorted(object_totals.items(), key=lambda kv: kv[1], reverse=True)[:5]
    samples_per_second = (fps / DEFAULT_FRAME_STRIDE) if fps else 0
    
    summary = {
        "video": os.path.basename(input_path),
        "frame_count": frame_count,
        "duration_seconds": round(total_seconds, 2),
        "fps": round(fps, 2),
        "sampled_frames": len(counts),
        "sample_interval_frames": DEFAULT_FRAME_STRIDE,
        "person_counts": counts,
        "max_people": max_people,
        "min_people": min(person_series, default=0),
        "average_people": round(np.mean(person_series), 2) if person_series else 0,
        "median_people": round(float(np.median(person_series)), 2) if person_series else 0,
        "people_std_dev": round(float(np.std(person_series)), 2) if person_series else 0,
        "peak_occupancy_time_seconds": round(peak_time, 2),
        "average_people_change_per_sample": round(float(np.mean(people_deltas)), 2) if people_deltas else 0,
        "average_people_change_per_second": round(float(np.mean(people_deltas) * samples_per_second), 2) if people_deltas and samples_per_second else 0,
        "rapid_change_frames": sum(1 for delta in people_deltas if delta >= 3),
        "crowd_trend": {
            "people_trend_slope_per_sample": round(people_slope, 4),
            "people_trend_direction": _trend_direction(people_slope),
            "density_trend_slope_per_sample": round(density_slope, 4),
            "density_trend_direction": _trend_direction(density_slope),
        },
        "max_objects": max((item["total_objects"] for item in counts), default=0),
        "min_objects": min((item["total_objects"] for item in counts), default=0),
        "average_objects": round(sum(item["total_objects"] for item in counts) / len(counts), 2) if counts else 0,
        "frames_with_motion": moving_frames,
        "motion_percentage": round((moving_frames / len(counts) * 100), 2) if counts else 0,
        "object_analysis": {
            "unique_object_types": len(object_totals),
            "average_object_type_diversity": round(float(np.mean(object_type_diversity)), 2) if object_type_diversity else 0,
            "max_object_type_diversity": max(object_type_diversity, default=0),
            "top_detected_objects": [{"type": name, "count": count} for name, count in top_objects],
        },
        # New crowd metrics
        "crowd_analysis": {
            "total_crowd_frames": crowd_frames,
            "crowd_percentage": round((crowd_frames / len(counts) * 100), 2) if counts else 0,
            "max_crowd_size": max_crowd_size,
            "average_crowd_size": round(avg_crowd_size, 2),
            "frames_with_crowds": crowd_frames,
            "crowd_event_count": crowd_event_count,
            "longest_crowd_event_frames": longest_crowd_event,
            "longest_crowd_event_seconds": round((longest_crowd_event / samples_per_second), 2) if samples_per_second else 0,
        },
        "density_analysis": {
            "max_density": round(max((item.get("crowd_density", 0) for item in counts), default=0), 2),
            "average_density": round(np.mean([item.get("crowd_density", 0) for item in counts]), 2) if counts else 0,
        }
    }

    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as fh:
        json.dump(summary, fh, indent=2, cls=_NumpyEncoder)

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
