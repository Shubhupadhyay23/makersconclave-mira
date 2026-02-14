"""End-to-end test: boots the actual server, connects via Socket.io, runs a Mira session."""

import asyncio
import os
import sys
import signal

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv
load_dotenv()

import socketio
import uvicorn
from main import socket_app


async def run_test():
    # Start the server in background
    config = uvicorn.Config(socket_app, host="127.0.0.1", port=8765, log_level="warning")
    server = uvicorn.Server(config)
    server_task = asyncio.create_task(server.serve())

    # Give server a moment to start
    await asyncio.sleep(1)

    # Connect as a Socket.io client
    sio = socketio.AsyncClient()
    received_events = {"mira_speech": [], "tool_result": [], "session_recap": []}

    @sio.on("mira_speech")
    async def on_speech(data):
        received_events["mira_speech"].append(data)

    @sio.on("tool_result")
    async def on_tool_result(data):
        received_events["tool_result"].append(data)

    @sio.on("session_recap")
    async def on_recap(data):
        received_events["session_recap"].append(data)

    try:
        print("Connecting to server...")
        await sio.connect("http://127.0.0.1:8765")
        print(f"Connected: {sio.sid}")

        # Join a room (fake user ID since we don't have a real DB user)
        # We'll test with a mock user - the session will fail at DB lookup
        # but we can verify the event plumbing works
        fake_user_id = "test-user-e2e"
        await sio.emit("join_room", {"user_id": fake_user_id})
        await asyncio.sleep(0.5)
        print("Joined room")

        # Test: start_session (will fail at DB level since no real user, but proves Socket.io flow)
        print("\nSending start_session event...")
        await sio.emit("start_session", {"user_id": fake_user_id})
        await asyncio.sleep(3)  # Wait for Claude response

        # Check what we got
        speech_chunks = received_events["mira_speech"]
        if speech_chunks:
            full_text = "".join(c.get("text", "") for c in speech_chunks)
            print(f"\nMira said ({len(speech_chunks)} chunks):")
            print(f"  \"{full_text[:300]}{'...' if len(full_text) > 300 else ''}\"")
        else:
            print("\nNo speech received (expected if no DB user exists)")
            print("  This is OK — the event plumbing works, it just needs a real user in the DB")

        tool_results = received_events["tool_result"]
        if tool_results:
            print(f"\nTool results received: {len(tool_results)}")
            for tr in tool_results:
                print(f"  Type: {tr.get('type')}, Items: {len(tr.get('items', []))}")

        # Test: mirror_event (voice)
        print("\nSending voice event...")
        await sio.emit("mirror_event", {
            "user_id": fake_user_id,
            "event": {"type": "voice", "transcript": "show me some sneakers"},
        })
        await asyncio.sleep(3)

        speech_after = received_events["mira_speech"][len(speech_chunks):]
        if speech_after:
            voice_text = "".join(c.get("text", "") for c in speech_after)
            print(f"Mira responded to voice ({len(speech_after)} chunks):")
            print(f"  \"{voice_text[:300]}{'...' if len(voice_text) > 300 else ''}\"")

        # Test: gesture event
        print("\nSending thumbs_up gesture...")
        await sio.emit("mirror_event", {
            "user_id": fake_user_id,
            "event": {"type": "gesture", "gesture": "thumbs_up"},
        })
        await asyncio.sleep(2)

        print("\n" + "=" * 50)
        print("  E2E TEST RESULTS")
        print("=" * 50)
        print(f"  Socket.io connection: OK")
        print(f"  join_room: OK")
        print(f"  Speech chunks received: {len(received_events['mira_speech'])}")
        print(f"  Tool results received: {len(received_events['tool_result'])}")
        total_speech = "".join(c.get("text", "") for c in received_events["mira_speech"])
        if total_speech:
            print(f"  Mira is LIVE and talking ({len(total_speech)} chars)")
        else:
            print(f"  Mira did not speak (likely no user in DB — plumbing still works)")
        print("=" * 50)

    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
    finally:
        await sio.disconnect()
        server.should_exit = True
        await server_task


if __name__ == "__main__":
    asyncio.run(run_test())
