export type GestureType = "swipe_left" | "swipe_right" | "thumbs_up" | "thumbs_down";

export interface DetectedGesture {
  type: GestureType;
  confidence: number;
  timestamp: number;
}

export interface LandmarkPoint {
  x: number;
  y: number;
  z: number;
}

export interface SwipeState {
  positions: { x: number; timestamp: number }[];
  lastGestureTime: number;
}
