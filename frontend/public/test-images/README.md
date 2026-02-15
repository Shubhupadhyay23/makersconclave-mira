# Test Images for Clothing Overlay

This directory contains transparent PNG images for testing the clothing overlay system.

## Required Images

Place transparent PNG files (background removed) in the appropriate subdirectories:

### Tops (`/tops/`)
- `white-tshirt.png` - White t-shirt
- `black-hoodie.png` - Black hoodie
- `denim-jacket.png` - Denim jacket

### Bottoms (`/bottoms/`)
- `blue-jeans.png` - Blue jeans
- `black-pants.png` - Black dress pants
- `khaki-shorts.png` - Khaki shorts

## Image Requirements

1. **Format**: PNG with transparent background
2. **Background removal**: Use [remove.bg](https://remove.bg) or the backend `/api/images/remove-background` endpoint
3. **Perspective**: Front-facing flat lay product photos work best
4. **Resolution**: Minimum 1000px height recommended
5. **Aspect ratio**: Keep natural clothing proportions (don't crop to square)

## How to Get Images

### Option 1: From Agent Recommendations
1. Run the stylist agent to get clothing recommendations
2. Copy the product image URLs
3. Use remove.bg or backend endpoint to remove background
4. Save as PNG in appropriate directory

### Option 2: Manual Collection
1. Find product images on shopping sites
2. Download high-res images
3. Remove background using:
   - [remove.bg](https://remove.bg) (online tool)
   - Backend endpoint: `POST /api/images/remove-background`
   - Photoshop or GIMP (manual)
4. Save as PNG in appropriate directory

### Option 3: Test with URLs
You can also test directly by pasting image URLs into the sidebar UI without downloading files.

## Example Sources
- Google Shopping product images
- Retailer product pages (Zara, H&M, Uniqlo, etc.)
- Fashion e-commerce sites
- Stock photo sites (Unsplash, Pexels)

## Background Removal Tips
- Use well-lit product photos for best results
- Avoid images with complex shadows
- Front-facing photos work better than angled shots
- Ensure the entire garment is visible in the frame
