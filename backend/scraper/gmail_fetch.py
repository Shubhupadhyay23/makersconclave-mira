"""Gmail message search and content extraction."""

import base64
from email.utils import parsedate_to_datetime


def search_emails(service, query: str, max_results: int = 10) -> list[str]:
    """Search Gmail for messages matching query. Returns list of message IDs."""
    response = (
        service.users()
        .messages()
        .list(userId="me", q=query, maxResults=max_results)
        .execute()
    )
    messages = response.get("messages", [])
    return [m["id"] for m in messages]


def get_message_content(service, message_id: str) -> dict:
    """Fetch a single Gmail message and extract subject, sender, date, body."""
    msg = (
        service.users()
        .messages()
        .get(userId="me", id=message_id, format="full")
        .execute()
    )
    payload = msg.get("payload", {})
    headers = {h["name"]: h["value"] for h in payload.get("headers", [])}

    body_text = _extract_body(payload)

    date_str = headers.get("Date", "")
    parsed_date = None
    if date_str:
        try:
            parsed_date = parsedate_to_datetime(date_str).isoformat()
        except Exception:
            parsed_date = date_str

    return {
        "message_id": message_id,
        "subject": headers.get("Subject", ""),
        "sender": headers.get("From", ""),
        "date": parsed_date,
        "body": body_text,
    }


def _find_mime_part(payload: dict, mime_type: str) -> str | None:
    """Recursively search MIME parts for the first part matching mime_type.

    Returns decoded text content or None if not found.
    """
    if payload.get("mimeType") == mime_type and "body" in payload:
        data = payload["body"].get("data", "")
        if data:
            return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")

    for part in payload.get("parts", []):
        result = _find_mime_part(part, mime_type)
        if result:
            return result

    return None


def _extract_body(payload: dict) -> str:
    """Extract text body from Gmail message payload.

    Strategy: prefer text/plain, fall back to text/html converted via BeautifulSoup.
    """
    plain = _find_mime_part(payload, "text/plain")
    if plain:
        return plain

    html = _find_mime_part(payload, "text/html")
    if html:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style"]):
            tag.decompose()
        return soup.get_text(separator="\n", strip=True)

    return ""
