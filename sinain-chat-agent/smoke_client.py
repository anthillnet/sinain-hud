"""Tiny WS client to exercise the sidecar (stands in for sinain-core's ChatService).
Usage: python smoke_client.py "your message"   (sidecar must be running)"""
import asyncio, json, sys, time
import websockets


async def main() -> None:
    msg = sys.argv[1] if len(sys.argv) > 1 else "In one sentence, what is a vector embedding?"
    port = 9610
    async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
        t0 = time.perf_counter(); ttfc = None
        await ws.send(json.dumps({"message": msg, "context": {"kind": "main", "seed": ""}}))
        async for raw in ws:
            ev = json.loads(raw)
            t = (time.perf_counter() - t0) * 1000
            if ev["type"] == "token":
                if ttfc is None:
                    ttfc = t; print(f"  [ttfc {ttfc:.0f}ms]", flush=True)
                print(ev["text"], end="", flush=True)
            elif ev["type"] == "tool_call":
                print(f"\n  → tool: {ev['tool_name']}({ev.get('tool_args')})", flush=True)
            elif ev["type"] == "tool_result":
                print(f"  ← {ev['tool_result'][:80]!r}", flush=True)
            elif ev["type"] == "done":
                print(f"\n  [done {t:.0f}ms]", flush=True); break
            elif ev["type"] == "error":
                print(f"\n  [ERROR] {ev['text']}", flush=True); break


if __name__ == "__main__":
    asyncio.run(main())
