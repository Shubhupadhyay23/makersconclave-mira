"""Socket.io events for scraping progress updates."""


async def emit_purchase_found(
    sio,
    user_id: str,
    email_subject: str,
    purchases: list[dict],
    total_so_far: int,
) -> None:
    """Emit a per-email purchase event as each email is parsed."""
    await sio.emit(
        "purchase_found",
        {
            "user_id": user_id,
            "email_subject": email_subject,
            "purchases": purchases,
            "total_so_far": total_so_far,
        },
        room=user_id,
    )


async def emit_scrape_progress(
    sio,
    user_id: str,
    purchases_count: int,
    brands_found: list[str],
    phase: str,
) -> None:
    """Emit scrape progress to the user's room."""
    await sio.emit(
        "scrape_progress",
        {
            "user_id": user_id,
            "purchases_count": purchases_count,
            "brands_found": brands_found,
            "phase": phase,
        },
        room=user_id,
    )


async def emit_scrape_complete(
    sio,
    user_id: str,
    profile: dict,
) -> None:
    """Emit scrape completion with final profile."""
    await sio.emit(
        "scrape_complete",
        {
            "user_id": user_id,
            "profile": profile,
        },
        room=user_id,
    )
