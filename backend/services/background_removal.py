"""Background removal service using rembg.

Removes backgrounds from flat lay product images so they can be
overlaid transparently on the mirror display.
"""

import asyncio
import base64
import io
from functools import lru_cache

from PIL import Image
from rembg import new_session, remove


@lru_cache(maxsize=1)
def _get_session():
    """Lazily create and cache the rembg model session."""
    return new_session("u2net")


def _remove_bg(image_bytes: bytes) -> bytes:
    """Synchronous background removal. Runs in thread executor."""
    session = _get_session()
    input_image = Image.open(io.BytesIO(image_bytes))
    output_image = remove(input_image, session=session)
    buf = io.BytesIO()
    output_image.save(buf, format="PNG")
    return buf.getvalue()


async def remove_background(image_data_url: str) -> str:
    """Remove background from a base64 data URL image.

    Args:
        image_data_url: Base64 data URL (e.g. "data:image/png;base64,...")

    Returns:
        New data URL with transparent background as PNG.
    """
    # Parse data URL
    header, b64_data = image_data_url.split(",", 1)
    image_bytes = base64.b64decode(b64_data)

    # Run CPU-bound rembg in thread executor
    loop = asyncio.get_running_loop()
    result_bytes = await loop.run_in_executor(None, _remove_bg, image_bytes)

    result_b64 = base64.b64encode(result_bytes).decode("utf-8")
    return f"data:image/png;base64,{result_b64}"
