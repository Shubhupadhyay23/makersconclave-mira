# Clothing Overlay Test Page - Implementation Spec

**Date**: 2026-02-14
**Purpose**: Isolated test harness for clothing overlay development at `/mirror/test`
**Scope**: Display clothing on body using MediaPipe pose detection, separate from login/onboarding

## Overview

Build a standalone development test page that renders clothing images overlaid on the user's body in real-time using webcam + MediaPipe BlazePose. This is a pure testing environment with keyboard controls and debug visualizations, isolated from the full mirror experience to enable rapid iteration on the overlay system.

## Goals

1. Test clothing image warping onto body landmarks without needing backend/agent integration
2. Rapid development environment with keyboard shortcuts and debug visuals
3. Support any webcam (built-in laptop or external USB)
4. Fixed 1920x1080 canvas matching production mirror setup
5. Sidebar UI for adding clothing URLs dynamically
6. Starter set of test images provided

## User Journey

1. Developer navigates to `/mirror/test`
2. Browser requests camera permission → developer allows
3. MediaPipe BlazePose initializes (~2-3 seconds)
4. Webcam feed starts (hidden, only landmarks shown)
5. Default test outfit appears overlaid on developer's body
6. Developer uses arrow keys to cycle through test outfits
7. Developer pastes new clothing URLs via sidebar to test different images
8. Debug mode shows pose landmarks, anchor points, and bounding boxes

## Technical Architecture

### Page Structure

```
/frontend/src/app/mirror/test/
  ├── page.tsx                    # Main test page
  ├── components/
  │   ├── ClothingCanvas.tsx       # Canvas rendering with transforms
  │   ├── DebugOverlay.tsx         # Landmarks, anchors, bounding boxes
  │   └── TestSidebar.tsx          # URL input controls
  └── lib/
      ├── test-data.ts             # Hardcoded test clothing items
      └── clothing-transform.ts    # Affine transform calculations
```

### Data Flow

```
Webcam
  ↓
MediaPipe BlazePose (Heavy mode, 30fps)
  ↓
Normalized landmarks (0-1 coords) + visibility scores
  ↓
clothing-transform.ts (calculate 6-point transforms)
  ↓
ClothingCanvas (render with Canvas API)
  ↓
Display: overlaid clothing + optional debug visuals

Keyboard input → cycle test array → trigger re-render
Sidebar form → add to test array → trigger re-render
```

## Core Features

### 1. Clothing Data Structure

Each clothing piece is separate and independent:

```typescript
interface ClothingItem {
  id: string;
  category: 'tops' | 'bottoms';
  imageUrl: string;        // Transparent PNG with background removed
  name?: string;           // For display in sidebar
  brand?: string;
}

// Example test array
const testClothes: ClothingItem[] = [
  { id: 't1', category: 'tops', imageUrl: '/test-images/tops/white-tshirt.png', name: 'White T-Shirt' },
  { id: 't2', category: 'tops', imageUrl: '/test-images/tops/black-hoodie.png', name: 'Black Hoodie' },
  { id: 'b1', category: 'bottoms', imageUrl: '/test-images/bottoms/blue-jeans.png', name: 'Blue Jeans' },
  // ...
];

// Current display: array of items to show simultaneously
const currentItems: ClothingItem[] = [testClothes[0], testClothes[2]]; // top + bottom
```

### 2. MediaPipe BlazePose Integration

**Configuration**:
- Model: Heavy mode for best accuracy
- Running mode: VIDEO
- Frame rate: ~30fps (no throttling)
- Single person detection

**Landmark mapping for clothing categories**:

**Tops** (6-point anchor):
- Left shoulder: landmark 11
- Right shoulder: landmark 12
- Left elbow: landmark 13
- Right elbow: landmark 14
- Left hip: landmark 23
- Right hip: landmark 24

**Bottoms** (6-point anchor):
- Left hip: landmark 23
- Right hip: landmark 24
- Left knee: landmark 25
- Right knee: landmark 26
- Left ankle: landmark 27
- Right ankle: landmark 28

**Visibility threshold**: Only render if ALL required landmarks have `visibility > 0.5`

### 3. Coordinate System

**Normalized coordinates (0-1)**:
- MediaPipe returns landmarks in normalized space
- Keep normalized throughout calculations
- Only convert to pixels at final render time:
  ```typescript
  const pixelX = landmark.x * CANVAS_WIDTH;  // 1920
  const pixelY = landmark.y * CANVAS_HEIGHT; // 1080
  ```

**Benefits**:
- Resolution independent
- Cleaner math
- Easier debugging

### 4. Affine Transform Strategy

**Approach**: 6-point transform with 4-point rectangular projection

For tops:
1. Calculate bounding rectangle from shoulders (11, 12) and hips (23, 24)
2. Use elbows (13, 14) for fit validation but not for primary corners
3. Apply affine transform to warp clothing image corners to rectangle corners
4. Maintain clothing aspect ratio, scale to fit body region

**Transform calculation**:
```typescript
interface Transform {
  centerX: number;    // Center point in pixels
  centerY: number;
  width: number;      // Width in pixels
  height: number;     // Height in pixels
  rotation: number;   // Rotation in radians
}

function calculateTopTransform(landmarks: Landmark[]): Transform | null {
  const lShoulder = landmarks[11];
  const rShoulder = landmarks[12];
  const lHip = landmarks[23];
  const rHip = landmarks[24];

  // Check visibility
  if (any visibility < 0.5) return null;

  // Convert to pixels
  const tlPx = { x: lShoulder.x * 1920, y: lShoulder.y * 1080 };
  const trPx = { x: rShoulder.x * 1920, y: rShoulder.y * 1080 };
  const blPx = { x: lHip.x * 1920, y: lHip.y * 1080 };
  const brPx = { x: rHip.x * 1920, y: rHip.y * 1080 };

  // Calculate center
  const centerX = (tlPx.x + trPx.x + blPx.x + brPx.x) / 4;
  const centerY = (tlPx.y + trPx.y + blPx.y + brPx.y) / 4;

  // Calculate dimensions
  const topWidth = distance(tlPx, trPx);
  const bottomWidth = distance(blPx, brPx);
  const width = (topWidth + bottomWidth) / 2 * 1.1; // 10% padding

  const leftHeight = distance(tlPx, blPx);
  const rightHeight = distance(trPx, brPx);
  const height = (leftHeight + rightHeight) / 2 * 1.1;

  // Calculate rotation from top edge
  const rotation = Math.atan2(trPx.y - tlPx.y, trPx.x - tlPx.x);

  return { centerX, centerY, width, height, rotation };
}
```

**Aspect ratio handling**: Maintain aspect ratio, scale to fit
- Preserve clothing image proportions
- Scale to cover body region without distortion
- May leave small gaps but looks more realistic than stretching

### 5. Canvas Rendering

**Setup**:
```typescript
const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

// Canvas element
<canvas
  width={CANVAS_WIDTH}
  height={CANVAS_HEIGHT}
  style={{ width: '100%', height: '100%' }}
/>
```

**Render loop** (triggered by pose updates):
```typescript
function render(ctx: CanvasRenderingContext2D, items: ClothingItem[], landmarks: Landmark[]) {
  // Clear canvas
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // Render in fixed z-order: bottoms → tops
  const sorted = items.sort((a, b) => {
    const order = { bottoms: 0, tops: 1 };
    return order[a.category] - order[b.category];
  });

  for (const item of sorted) {
    const transform = calculateTransform(landmarks, item.category);
    if (!transform) continue; // Skip if landmarks not visible

    const img = loadedImages.get(item.id);
    if (!img) continue;

    // Apply transform and draw
    ctx.save();
    ctx.translate(transform.centerX, transform.centerY);
    ctx.rotate(transform.rotation);

    // Scale to maintain aspect ratio
    const { drawWidth, drawHeight } = scaleToFit(
      img.width,
      img.height,
      transform.width,
      transform.height
    );

    ctx.drawImage(
      img,
      -drawWidth / 2,
      -drawHeight / 2,
      drawWidth,
      drawHeight
    );

    ctx.restore();
  }
}

function scaleToFit(imgW: number, imgH: number, targetW: number, targetH: number) {
  const imgAspect = imgW / imgH;
  const targetAspect = targetW / targetH;

  if (imgAspect > targetAspect) {
    // Image is wider - fit to width
    return { drawWidth: targetW, drawHeight: targetW / imgAspect };
  } else {
    // Image is taller - fit to height
    return { drawWidth: targetH * imgAspect, drawHeight: targetH };
  }
}
```

**Opacity**: Fully opaque (alpha = 1.0)

### 6. Partial Body Handling

**Strategy**: Render only visible clothing regions

```typescript
function shouldRenderTop(landmarks: Landmark[]): boolean {
  const required = [11, 12, 13, 14, 23, 24];
  return required.every(i => landmarks[i].visibility > 0.5);
}

function shouldRenderBottoms(landmarks: Landmark[]): boolean {
  const required = [23, 24, 25, 26, 27, 28];
  return required.every(i => landmarks[i].visibility > 0.5);
}

// In render loop
if (item.category === 'tops' && !shouldRenderTop(landmarks)) continue;
if (item.category === 'bottoms' && !shouldRenderBottoms(landmarks)) continue;
```

**Examples**:
- User's legs out of frame → render only top
- User's upper body out of frame → render only bottoms
- Full body out of frame → render nothing

### 7. Tracking Loss Behavior

**Freeze overlay at last known position**:
```typescript
const lastKnownPose = useRef<Landmark[] | null>(null);

function render() {
  const poseToUse = currentPose || lastKnownPose.current;
  if (poseToUse) {
    // Render with this pose
    drawClothing(poseToUse);

    // Update last known
    if (currentPose) {
      lastKnownPose.current = currentPose;
    }
  }
}
```

No fade out, no "stand in frame" message - just freeze until tracking resumes.

### 8. Debug Visualization

**Toggle with D key** (default: ON for test page)

Three debug layers rendered on top of clothing:

1. **Pose landmarks and skeleton** (cyan):
   ```typescript
   // Draw all 33 landmarks
   for (const landmark of landmarks) {
     const x = landmark.x * 1920;
     const y = landmark.y * 1080;

     ctx.fillStyle = 'cyan';
     ctx.beginPath();
     ctx.arc(x, y, 5, 0, Math.PI * 2);
     ctx.fill();
   }

   // Draw skeleton connections
   const connections = [
     [11, 12], [11, 13], [13, 15], // Left arm
     [12, 14], [14, 16], // Right arm
     [11, 23], [12, 24], // Torso
     [23, 24], // Hips
     [23, 25], [25, 27], // Left leg
     [24, 26], [26, 28], // Right leg
   ];

   ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
   ctx.lineWidth = 2;
   for (const [a, b] of connections) {
     ctx.beginPath();
     ctx.moveTo(landmarks[a].x * 1920, landmarks[a].y * 1080);
     ctx.lineTo(landmarks[b].x * 1920, landmarks[b].y * 1080);
     ctx.stroke();
   }
   ```

2. **Transform anchor points** (red for tops, green for bottoms):
   ```typescript
   function drawAnchors(landmarks: Landmark[], category: string) {
     const indices = category === 'tops'
       ? [11, 12, 13, 14, 23, 24]
       : [23, 24, 25, 26, 27, 28];

     ctx.fillStyle = category === 'tops' ? 'red' : 'lime';
     for (const idx of indices) {
       const x = landmarks[idx].x * 1920;
       const y = landmarks[idx].y * 1080;

       ctx.beginPath();
       ctx.arc(x, y, 8, 0, Math.PI * 2);
       ctx.fill();
     }
   }
   ```

3. **Clothing bounding boxes** (yellow):
   ```typescript
   function drawBoundingBox(transform: Transform) {
     ctx.save();
     ctx.translate(transform.centerX, transform.centerY);
     ctx.rotate(transform.rotation);

     ctx.strokeStyle = 'yellow';
     ctx.lineWidth = 3;
     ctx.strokeRect(
       -transform.width / 2,
       -transform.height / 2,
       transform.width,
       transform.height
     );

     ctx.restore();
   }
   ```

### 9. Keyboard Controls

**Outfit cycling**:
- `←` Left arrow: Previous outfit combination (instant swap)
- `→` Right arrow: Next outfit combination (instant swap)
- `1-9` Number keys: Jump to outfit index directly
- Spacebar: Toggle current item visibility

**Debug controls**:
- `D`: Toggle debug visualization on/off
- `F`: Toggle fullscreen mode
- `R`: Reset to first outfit

**Implementation**:
```typescript
useEffect(() => {
  function handleKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowLeft':
        setCurrentIndex(i => Math.max(0, i - 1));
        break;
      case 'ArrowRight':
        setCurrentIndex(i => Math.min(outfits.length - 1, i + 1));
        break;
      case 'd':
      case 'D':
        setDebugMode(d => !d);
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 'r':
      case 'R':
        setCurrentIndex(0);
        break;
      default:
        // Number keys 1-9
        const num = parseInt(e.key);
        if (num >= 1 && num <= 9) {
          setCurrentIndex(num - 1);
        }
    }
  }

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [outfits.length]);
```

**Transition**: Instant swap (0ms) - no animations for rapid testing

### 10. Sidebar UI for Test Data

**Layout**: Fixed sidebar on right, 350px wide

**Features**:
- Add clothing by URL
- Category selection dropdown
- Visual thumbnail preview
- Delete button per item
- Current outfit indicator

**Component structure**:
```tsx
function TestSidebar({
  items: ClothingItem[],
  onAdd: (item: ClothingItem) => void,
  onDelete: (id: string) => void,
  currentIndex: number
}) {
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState<'tops' | 'bottoms'>('tops');
  const [name, setName] = useState('');

  const handleAdd = () => {
    onAdd({
      id: generateId(),
      category,
      imageUrl: url,
      name: name || 'Unnamed item'
    });
    setUrl('');
    setName('');
  };

  return (
    <div style={{
      position: 'fixed',
      right: 0,
      top: 0,
      bottom: 0,
      width: 350,
      background: '#1a1a1a',
      padding: 20,
      overflowY: 'auto',
      color: '#fff'
    }}>
      <h2>Test Controls</h2>

      {/* Add form */}
      <div style={{ marginBottom: 30 }}>
        <input
          type="text"
          placeholder="Clothing image URL"
          value={url}
          onChange={e => setUrl(e.target.value)}
          style={{ width: '100%', marginBottom: 8 }}
        />
        <input
          type="text"
          placeholder="Name (optional)"
          value={name}
          onChange={e => setName(e.target.value)}
          style={{ width: '100%', marginBottom: 8 }}
        />
        <select value={category} onChange={e => setCategory(e.target.value as any)}>
          <option value="tops">Tops</option>
          <option value="bottoms">Bottoms</option>
        </select>
        <button onClick={handleAdd} disabled={!url}>
          Add Item
        </button>
      </div>

      {/* Current items */}
      <h3>Current Items ({items.length})</h3>
      {items.map((item, idx) => (
        <div key={item.id} style={{
          marginBottom: 12,
          padding: 10,
          background: idx === currentIndex ? '#333' : '#222',
          borderRadius: 8
        }}>
          <div>{item.name || 'Unnamed'}</div>
          <div style={{ fontSize: '0.8rem', color: '#999' }}>{item.category}</div>
          <img src={item.imageUrl} style={{ width: 60, height: 60, marginTop: 8 }} />
          <button onClick={() => onDelete(item.id)}>Delete</button>
        </div>
      ))}

      {/* Keyboard shortcuts help */}
      <div style={{ marginTop: 30, fontSize: '0.85rem', color: '#666' }}>
        <div>← → : Cycle outfits</div>
        <div>1-9 : Jump to outfit</div>
        <div>D : Toggle debug</div>
        <div>F : Fullscreen</div>
        <div>R : Reset</div>
      </div>
    </div>
  );
}
```

### 11. Test Data Setup

**Starter images** in `/public/test-images/`:

**Tops** (3 items):
- `/test-images/tops/white-tshirt.png` - Basic white t-shirt
- `/test-images/tops/black-hoodie.png` - Black hoodie
- `/test-images/tops/denim-jacket.png` - Light denim jacket

**Bottoms** (3 items):
- `/test-images/bottoms/blue-jeans.png` - Classic blue jeans
- `/test-images/bottoms/black-pants.png` - Black dress pants
- `/test-images/bottoms/khaki-shorts.png` - Khaki shorts

**Image requirements**:
- Format: PNG with transparent background
- Background removal: Use rembg, Photoshop, or remove.bg
- Perspective: Front-facing flat lay preferred
- Resolution: 1000px height minimum recommended
- Aspect ratio: Natural clothing proportions (don't crop to square)

**Hardcoded default array**:
```typescript
// frontend/src/app/mirror/test/lib/test-data.ts

export const DEFAULT_TEST_CLOTHES: ClothingItem[] = [
  {
    id: 't1',
    category: 'tops',
    imageUrl: '/test-images/tops/white-tshirt.png',
    name: 'White T-Shirt'
  },
  {
    id: 't2',
    category: 'tops',
    imageUrl: '/test-images/tops/black-hoodie.png',
    name: 'Black Hoodie'
  },
  {
    id: 't3',
    category: 'tops',
    imageUrl: '/test-images/tops/denim-jacket.png',
    name: 'Denim Jacket'
  },
  {
    id: 'b1',
    category: 'bottoms',
    imageUrl: '/test-images/bottoms/blue-jeans.png',
    name: 'Blue Jeans'
  },
  {
    id: 'b2',
    category: 'bottoms',
    imageUrl: '/test-images/bottoms/black-pants.png',
    name: 'Black Pants'
  },
  {
    id: 'b3',
    category: 'bottoms',
    imageUrl: '/test-images/bottoms/khaki-shorts.png',
    name: 'Khaki Shorts'
  },
];

// Outfit combinations (top + bottom)
export const DEFAULT_OUTFITS: ClothingItem[][] = [
  [DEFAULT_TEST_CLOTHES[0], DEFAULT_TEST_CLOTHES[3]], // White tee + blue jeans
  [DEFAULT_TEST_CLOTHES[1], DEFAULT_TEST_CLOTHES[4]], // Hoodie + black pants
  [DEFAULT_TEST_CLOTHES[2], DEFAULT_TEST_CLOTHES[3]], // Jacket + blue jeans
  // ... etc
];
```

### 12. Error Handling

**For development, errors must be visible and actionable**

**Image load failures**:
```typescript
const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());

function preloadImage(item: ClothingItem): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => resolve(img);
    img.onerror = () => {
      const errorMsg = `Failed to load: ${item.imageUrl}`;
      setImageErrors(prev => new Map(prev).set(item.id, errorMsg));
      showToast(errorMsg, 'error');
      reject(new Error(errorMsg));
    };

    img.src = item.imageUrl;
  });
}

// Toast notification
function showToast(message: string, type: 'error' | 'success') {
  // Display toast at top-right
  // Auto-dismiss after 5 seconds
  // Click to dismiss
}
```

**MediaPipe initialization failures**:
```typescript
if (poseError) {
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#000',
      color: '#fff',
      flexDirection: 'column',
      gap: 20
    }}>
      <div style={{ fontSize: '2rem', color: '#f44' }}>
        MediaPipe Error
      </div>
      <div style={{ fontSize: '1.2rem', maxWidth: 600, textAlign: 'center' }}>
        {poseError}
      </div>
      <div style={{ fontSize: '1rem', color: '#999' }}>
        Try refreshing the page or check console for details
      </div>
      <button onClick={() => window.location.reload()}>
        Retry
      </button>
    </div>
  );
}
```

**Webcam access denied**:
```typescript
if (cameraError?.includes('Permission denied')) {
  return (
    <div style={{ /* modal styling */ }}>
      <h2>Camera Access Required</h2>
      <p>This test page needs camera access to detect your body position.</p>
      <p>Please allow camera permission in your browser settings.</p>
      <details>
        <summary>How to enable camera</summary>
        <ul>
          <li><strong>Chrome:</strong> Click the camera icon in address bar</li>
          <li><strong>Firefox:</strong> Click the crossed-out camera icon</li>
          <li><strong>Safari:</strong> Safari > Settings > Websites > Camera</li>
        </ul>
      </details>
    </div>
  );
}
```

**Performance warnings**:
```typescript
const fpsRef = useRef<number[]>([]);

useEffect(() => {
  const now = performance.now();
  fpsRef.current.push(now);

  // Keep last 60 frames
  if (fpsRef.current.length > 60) {
    fpsRef.current.shift();
  }

  // Calculate FPS
  if (fpsRef.current.length >= 2) {
    const elapsed = now - fpsRef.current[0];
    const fps = (fpsRef.current.length / elapsed) * 1000;

    if (fps < 20) {
      console.warn(`Low FPS: ${fps.toFixed(1)} - consider disabling debug mode`);
    }
  }
}, [currentPose]);
```

## UI Layout

```
┌────────────────────────────────────────────────────────────┬─────────────────┐
│                                                            │  TEST SIDEBAR   │
│                    BLACK BACKGROUND                        │                 │
│                       (1920x1080)                          │  Add Item:      │
│                                                            │  URL: [_______] │
│    ┌──────────────────────────────────────────┐           │  Name: [______] │
│    │                                          │           │  Category: [▼]  │
│    │      CLOTHING OVERLAY CANVAS             │           │  [Add Item]     │
│    │      (clothing images warped onto        │           │                 │
│    │       body landmarks)                    │           │  Current Items: │
│    │                                          │           │  ☑ White Tee    │
│    │      [Optional debug overlay:]           │           │  ☐ Hoodie       │
│    │      - Cyan skeleton                     │           │  ☐ Blue Jeans   │
│    │      - Red/green anchor dots             │           │                 │
│    │      - Yellow bounding boxes             │           │  Controls:      │
│    │                                          │           │  ← → : Cycle    │
│    └──────────────────────────────────────────┘           │  D : Debug      │
│                                                            │  F : Fullscreen │
│                                                            │  R : Reset      │
│  [Error toasts appear at top-right]                       │                 │
│                                                            │                 │
└────────────────────────────────────────────────────────────┴─────────────────┘
```

## Implementation Checklist

### Core Infrastructure
- [ ] Create `/mirror/test` route and page.tsx
- [ ] Set up MediaPipe BlazePose hook (heavy mode)
- [ ] Set up webcam access hook
- [ ] Create 1920x1080 Canvas element
- [ ] Create ClothingItem TypeScript interfaces

### Transform & Rendering
- [ ] Implement landmark-to-pixel coordinate conversion
- [ ] Implement 6-point transform calculation for tops
- [ ] Implement 6-point transform calculation for bottoms
- [ ] Implement aspect-ratio-preserving scale-to-fit
- [ ] Implement Canvas rendering loop
- [ ] Implement fixed z-order layering (bottoms → tops)
- [ ] Handle partial body visibility (only render visible items)
- [ ] Implement freeze-on-tracking-loss behavior

### Debug Visualization
- [ ] Render pose landmarks (cyan dots)
- [ ] Render pose skeleton (cyan lines)
- [ ] Render anchor points (red for tops, green for bottoms)
- [ ] Render bounding boxes (yellow rectangles)
- [ ] Add keyboard toggle for debug mode (D key)

### Keyboard Controls
- [ ] Left arrow: previous outfit
- [ ] Right arrow: next outfit
- [ ] Number keys 1-9: jump to outfit
- [ ] D key: toggle debug mode
- [ ] F key: toggle fullscreen
- [ ] R key: reset to first outfit
- [ ] Spacebar: toggle item visibility

### Sidebar UI
- [ ] Create TestSidebar component
- [ ] Add URL input field
- [ ] Add name input field
- [ ] Add category dropdown
- [ ] Add "Add Item" button
- [ ] Display current items list with thumbnails
- [ ] Add delete button per item
- [ ] Highlight currently displayed outfit
- [ ] Display keyboard shortcuts reference

### Test Data
- [ ] Source/create 3 transparent PNG tops
- [ ] Source/create 3 transparent PNG bottoms
- [ ] Save to `/public/test-images/`
- [ ] Create DEFAULT_TEST_CLOTHES array
- [ ] Create DEFAULT_OUTFITS combinations array
- [ ] Implement image preloading logic

### Error Handling
- [ ] Image load failure toasts
- [ ] Console error logging for all errors
- [ ] MediaPipe init failure modal
- [ ] Webcam permission denied modal with instructions
- [ ] Mark failed items in sidebar
- [ ] FPS performance warnings in console

### Testing
- [ ] Test with built-in webcam
- [ ] Test with external USB webcam
- [ ] Test all keyboard shortcuts
- [ ] Test sidebar add/delete functionality
- [ ] Test with various lighting conditions
- [ ] Test partial body visibility (legs out of frame, etc.)
- [ ] Test tracking loss and freeze behavior
- [ ] Test with different body positions (sitting, standing, side profile)

## Technical Notes

### MediaPipe Configuration
```typescript
import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const vision = await FilesetResolver.forVisionTasks(
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
);

const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
    delegate: 'GPU'
  },
  runningMode: 'VIDEO',
  numPoses: 1,
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5
});
```

### Canvas Best Practices
- Clear canvas every frame: `ctx.clearRect(0, 0, width, height)`
- Use `save()` and `restore()` for transform isolation
- Pre-load images before rendering
- Use `requestAnimationFrame` for render loop
- Avoid recreating Image objects unnecessarily

### Future Integration Path
This test page is isolated but designed to share code with production:
1. `clothing-transform.ts` → can be reused in main `/mirror` page
2. Transform calculations → same in production
3. Test with real agent-recommended images via sidebar URL input
4. Once overlay works well, integrate into full mirror experience

## Success Criteria

✅ **MVP Complete When**:
1. Test page loads at `/mirror/test` without errors
2. Webcam permission granted and video feed captured
3. MediaPipe BlazePose detects landmarks in real-time
4. At least one top and one bottom render overlaid on body correctly
5. Clothing follows body movement smoothly (<200ms latency)
6. Arrow keys cycle through outfits instantly
7. Debug mode (D key) shows all landmarks, anchors, and boxes
8. Sidebar can add new clothing URLs and they render correctly
9. Partial body visibility handled (only visible regions render)
10. Image load errors show visible toast notifications
11. Webcam access errors show clear instructions

## Edge Cases to Test

1. **Side profile pose** - only one shoulder visible
2. **Sitting down** - bottom landmarks change significantly
3. **Arms raised** - elbow landmarks move
4. **Multiple people in frame** - MediaPipe may detect wrong person
5. **Low lighting** - tracking may fail
6. **Different camera aspect ratios** - built-in laptop vs external USB
7. **Very large/small person** - transforms scale correctly
8. **Rapid movement** - overlay keeps up without jitter
9. **Face-on vs side-on clothing images** - aspect ratios vary
10. **Invalid image URLs** - errors handled gracefully

## Notes

- **Clothing images from agent**: User will get recommendations from stylist agent, grab the product image URLs, run them through background removal (remove.bg or backend rembg endpoint), then paste into sidebar for testing
- **6-point anchor but 4-point projection**: Use 6 landmarks for validation but project onto 4-corner rectangle for simplicity
- **No animations**: Instant swaps for rapid iteration
- **Black background**: Matches production mirror setup (one-way mirror film)
- **Fixed canvas size**: 1920x1080 regardless of window size (matches production mirror TV)
