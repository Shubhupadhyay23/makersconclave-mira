/**
 * MediaPipe BlazePose types
 */

export interface PoseLandmark {
  x: number;         // Normalized 0-1
  y: number;         // Normalized 0-1
  z: number;         // Depth (normalized)
  visibility: number; // 0-1 confidence score
}

export interface PoseResult {
  landmarks: PoseLandmark[];
  timestamp: number;
}

/**
 * BlazePose landmark indices for clothing overlay
 * https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
 */
export const POSE_LANDMARKS = {
  // Upper body
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,

  // Torso
  LEFT_HIP: 23,
  RIGHT_HIP: 24,

  // Lower body
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;
