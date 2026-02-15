"""Google Calendar API client — fetches upcoming events.

Uses googleapiclient (synchronous, httplib2-based).
Called via run_in_executor() from agent/memory.py.
"""

import datetime

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build


def build_calendar_service(token_data: dict):
    """Build a Google Calendar API service from an OAuth token dict."""
    creds = Credentials(
        token=token_data.get("access_token"),
        refresh_token=token_data.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=token_data.get("client_id"),
        client_secret=token_data.get("client_secret"),
    )
    return build("calendar", "v3", credentials=creds)


def fetch_events(service, days_back: int = 7, days_forward: int = 14) -> list[dict]:
    """Fetch calendar events from (now - days_back) to (now + days_forward).

    Returns a list of dicts with: google_event_id, title, start_time, end_time,
    location, description, attendee_count, is_all_day, status.
    """
    now = datetime.datetime.now(datetime.timezone.utc)
    time_min = (now - datetime.timedelta(days=days_back)).isoformat()
    time_max = (now + datetime.timedelta(days=days_forward)).isoformat()

    result = (
        service.events()
        .list(
            calendarId="primary",
            timeMin=time_min,
            timeMax=time_max,
            maxResults=50,
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )

    events = []
    for item in result.get("items", []):
        start = item.get("start", {})
        end = item.get("end", {})
        is_all_day = "date" in start and "dateTime" not in start

        events.append({
            "google_event_id": item.get("id", ""),
            "title": item.get("summary", ""),
            "start_time": start.get("dateTime") or start.get("date"),
            "end_time": end.get("dateTime") or end.get("date"),
            "location": item.get("location"),
            "description": item.get("description"),
            "attendee_count": len(item.get("attendees", [])),
            "is_all_day": is_all_day,
            "status": item.get("status"),
        })

    return events
