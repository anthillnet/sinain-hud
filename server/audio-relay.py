#!/usr/bin/env python3
"""
TCP Audio Relay — Lightweight TCP server that receives audio from Mac and serves it as HTTP.

Bridges Mac → (tcp) → Relay → (http) → Transcriber.
Run this on the server (same machine as OpenClaw), then point mac_audio_stream.sh at it.

Usage:
    # Start relay on port 9999 (TCP in) / 8899 (HTTP out)
    python3 tcp_relay.py --tcp-port 9999 --http-port 8899

    # Then from Mac:
    ./mac_audio_stream.sh --target tcp://your-server:9999

    # Then transcribe:
    python3 transcribe.py --source http://localhost:8899/stream --continuous
"""

import os
import sys
import socket
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from collections import deque
import argparse
import time

# Ring buffer for audio chunks — keeps last N seconds available for HTTP clients
BUFFER_SIZE = 100  # chunks
audio_buffer = deque(maxlen=BUFFER_SIZE)
buffer_lock = threading.Lock()
clients = []
clients_lock = threading.Lock()


class StreamHandler(BaseHTTPRequestHandler):
    """Serves live audio stream over HTTP."""

    def do_GET(self):
        if self.path != "/stream":
            self.send_error(404)
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        # Register this client
        event = threading.Event()
        client_buf = deque(maxlen=BUFFER_SIZE)
        client = {"event": event, "buf": client_buf, "active": True}

        with clients_lock:
            clients.append(client)

        try:
            while client["active"]:
                event.wait(timeout=5)
                event.clear()
                while client_buf:
                    chunk = client_buf.popleft()
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        client["active"] = False
                        break
        finally:
            with clients_lock:
                if client in clients:
                    clients.remove(client)

    def log_message(self, format, *args):
        pass  # Suppress HTTP logs


def tcp_receiver(tcp_port: int):
    """Receive audio data from Mac via TCP and distribute to HTTP clients."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", tcp_port))
    sock.listen(1)
    print(f"TCP listening on :{tcp_port}")

    while True:
        conn, addr = sock.accept()
        print(f"TCP connection from {addr}")
        try:
            while True:
                data = conn.recv(65536)
                if not data:
                    break

                with buffer_lock:
                    audio_buffer.append(data)

                # Push to all HTTP clients
                with clients_lock:
                    for client in clients:
                        client["buf"].append(data)
                        client["event"].set()

        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            conn.close()
            print(f"TCP disconnected: {addr}")


def main():
    parser = argparse.ArgumentParser(description="TCP → HTTP audio relay")
    parser.add_argument("--tcp-port", type=int, default=9999, help="TCP input port (default: 9999)")
    parser.add_argument("--http-port", type=int, default=8899, help="HTTP output port (default: 8899)")
    args = parser.parse_args()

    # Start TCP receiver thread
    tcp_thread = threading.Thread(target=tcp_receiver, args=(args.tcp_port,), daemon=True)
    tcp_thread.start()

    # Start HTTP server
    print(f"HTTP serving on :{args.http_port}/stream")
    print(f"\nPipeline:")
    print(f"  Mac → tcp://this-server:{args.tcp_port}")
    print(f"  Transcriber → http://localhost:{args.http_port}/stream")
    print()

    server = HTTPServer(("0.0.0.0", args.http_port), StreamHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutdown.")
        server.shutdown()


if __name__ == "__main__":
    main()
