# Mirror Test Page - Quick Start Guide

The clothing overlay test page is now ready at `/mirror/test`!

## 🚀 Quick Start

1. **Start the dev server:**
   ```bash
   cd frontend
   npm run dev
   ```

2. **Navigate to:** http://localhost:3000/mirror/test

3. **Allow camera access** when prompted

4. **Wait for models to load** (~5-10 seconds)
   - Camera initialization
   - MediaPipe BlazePose Heavy model download

5. **Start testing!**

## 📦 What's Included

### Core Features
- ✅ MediaPipe BlazePose (Heavy mode, 30fps)
- ✅ 6-point clothing transforms (shoulders + elbows + hips for tops)
- ✅ Canvas rendering with affine transforms
- ✅ Aspect ratio preservation
- ✅ Partial body handling (only render visible items)
- ✅ Freeze-on-tracking-loss behavior
- ✅ Fixed z-order layering (bottoms → tops)

### Debug Tools
- ✅ Pose landmarks (cyan dots)
- ✅ Pose skeleton (cyan lines)
- ✅ Anchor points (red for tops, green for bottoms)
- ✅ Bounding boxes (yellow rectangles)
- ✅ Toggle with `D` key

### UI Components
- ✅ Test sidebar with URL input
- ✅ Keyboard controls (arrow keys, 1-9, D, F, R)
- ✅ Error toasts for image load failures
- ✅ Current outfit indicator

## ⌨️ Keyboard Controls

| Key | Action |
|-----|--------|
| `←` `→` | Cycle through outfits |
| `1-9` | Jump to specific outfit |
| `D` | Toggle debug mode (default ON) |
| `F` | Toggle fullscreen |
| `R` | Reset to first outfit |

## 🖼️ Adding Test Images

### Option 1: Use Sidebar UI (Recommended)
1. Get clothing image URLs from stylist agent recommendations
2. Remove background using [remove.bg](https://remove.bg) or backend endpoint:
   ```bash
   POST http://localhost:8000/api/images/remove-background
   Body: { "image_url": "https://..." }
   ```
3. Upload the transparent PNG somewhere (or use a public URL)
4. Paste URL into sidebar
5. Select category (tops/bottoms)
6. Click "Add Item"

### Option 2: Local Files
1. Place transparent PNGs in:
   - `/frontend/public/test-images/tops/`
   - `/frontend/public/test-images/bottoms/`
2. Update `DEFAULT_TEST_CLOTHES` in `/frontend/src/app/mirror/test/lib/test-data.ts`
3. Restart dev server

## 🔧 Troubleshooting

### "Camera Access Required" Error
- Click camera icon in browser address bar
- Allow camera permission
- Refresh page

### "MediaPipe Error"
- Check console for details
- Ensure stable internet (model downloads from CDN)
- Try refreshing page
- Clear browser cache

### Images Not Loading
- Check image URLs are accessible
- Ensure images have transparent backgrounds (PNG format)
- Check browser console for CORS errors
- Try using remove.bg or backend endpoint for background removal

### Overlay Not Following Body
- Ensure good lighting conditions
- Stand fully in frame (full body visible)
- Face camera directly
- Wait for blue skeleton to appear (debug mode ON)

### Low FPS / Laggy
- Close other browser tabs
- Disable other apps using camera
- Try built-in webcam instead of external USB
- Check CPU usage in Activity Monitor/Task Manager

## 📝 Technical Details

### Canvas Size
- Fixed 1920x1080 (matches production mirror)
- Scaled to fit viewport automatically

### Coordinate System
- MediaPipe: Normalized 0-1 coordinates
- Converted to pixels at render time
- Resolution independent

### Transform Strategy
- **Tops**: 6-point anchor (shoulders 11,12 + elbows 13,14 + hips 23,24)
- **Bottoms**: 6-point anchor (hips 23,24 + knees 25,26 + ankles 27,28)
- Projects onto 4-corner rectangle
- 10% padding around clothing
- Maintains aspect ratio

### Visibility Threshold
- Minimum 0.5 visibility score required
- Only renders items with all required landmarks visible
- Freezes overlay when tracking lost (doesn't fade out)

## 🎯 Next Steps

Once the overlay works well:
1. Test with real agent-recommended clothing images
2. Fine-tune transform calculations if needed
3. Adjust padding/sizing constants
4. Test with different body types and poses
5. Integrate into main `/mirror` page when ready

## 📚 File Structure

```
frontend/src/app/mirror/test/
├── page.tsx                          # Main test page
├── components/
│   ├── ClothingCanvas.tsx            # Canvas rendering
│   ├── DebugOverlay.tsx              # Debug visualizations
│   └── TestSidebar.tsx               # Control sidebar
└── lib/
    ├── clothing-transform.ts         # Transform calculations
    └── test-data.ts                  # Default test data

frontend/src/types/
├── clothing.ts                       # Clothing item types
└── pose.ts                           # MediaPipe pose types

frontend/src/hooks/
└── usePoseDetection.ts               # MediaPipe hook
```

## 🐛 Known Issues

1. **Image thumbnails in sidebar**: Uses `<img>` instead of Next.js `<Image>` (intentional for test page)
2. **First load slow**: MediaPipe model downloads from CDN (~10MB)
3. **Sidebar outfit list**: Shows items individually, not grouped by outfit (can be improved)

## ✨ Future Enhancements

- [ ] Shoes category support
- [ ] Accessories category support
- [ ] FPS counter display
- [ ] Opacity slider (currently fixed at 1.0)
- [ ] Screenshot/save overlay feature
- [ ] Gesture detection integration
- [ ] Socket.io connection to backend
- [ ] Export test results
