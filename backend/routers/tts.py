"""ElevenLabs TTS proxy endpoint.

Proxies text-to-speech requests to ElevenLabs API so the API key
stays server-side.  Returns audio/mpeg binary via StreamingResponse.
"""

import os

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/tts", tags=["tts"])

ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1"


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=1000)


@router.post("/speak")
async def speak(body: SpeakRequest):
    """Convert text to speech via ElevenLabs and return audio/mpeg."""
    print(f"[tts] TTS request: {body.text[:100]}")
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    voice_id = os.environ.get("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")

    if not api_key:
        raise HTTPException(status_code=500, detail="ELEVENLABS_API_KEY not configured")

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(
                f"{ELEVENLABS_API_URL}/text-to-speech/{voice_id}",
                headers={
                    "Accept": "audio/mpeg",
                    "Content-Type": "application/json",
                    "xi-api-key": api_key,
                },
                json={
                    "text": body.text,
                    "model_id": "eleven_multilingual_v2",
                    "voice_settings": {
                        "stability": 0.5,
                        "similarity_boost": 0.8,
                        "style": 0.5,
                        "use_speaker_boost": True,
                    },
                },
                timeout=30.0,
            )
        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=502, detail=f"ElevenLabs request failed: {exc}"
            )

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs API error ({resp.status_code}): {resp.text[:200]}",
        )

    return StreamingResponse(
        iter([resp.content]),
        media_type="audio/mpeg",
        headers={"Content-Disposition": "inline"},
    )


@router.post("/stream")
async def stream_speech(body: SpeakRequest):
    """Stream audio from ElevenLabs — returns chunked audio/mpeg."""
    print(f"[tts] TTS stream request: {body.text[:100]}")
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    voice_id = os.environ.get("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")

    if not api_key:
        raise HTTPException(status_code=500, detail="ELEVENLABS_API_KEY not configured")

    async def audio_generator():
        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST",
                f"{ELEVENLABS_API_URL}/text-to-speech/{voice_id}/stream?optimize_streaming_latency=3",
                headers={
                    "Accept": "audio/mpeg",
                    "Content-Type": "application/json",
                    "xi-api-key": api_key,
                },
                json={
                    "text": body.text,
                    "model_id": "eleven_multilingual_v2",
                    "voice_settings": {
                        "stability": 0.5,
                        "similarity_boost": 0.8,
                        "style": 0.5,
                        "use_speaker_boost": True,
                    },
                },
                timeout=30.0,
            ) as resp:
                if resp.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"ElevenLabs stream error ({resp.status_code})",
                    )
                async for chunk in resp.aiter_bytes(1024):
                    yield chunk

    return StreamingResponse(audio_generator(), media_type="audio/mpeg")
