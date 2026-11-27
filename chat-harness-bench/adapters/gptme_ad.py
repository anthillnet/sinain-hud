"""gptme adapter (MIT). Sidecar in its OWN venv (.venv-gptme) — REQUIRED: gptme pins
openai<2.0, which conflicts with litellm's openai>=2.20 (the openhands/smolagents
stack). That conflict is why gptme can't run in-process and a subprocess sidecar is
the only clean path (validated 2026-06-15).

API shape discovered: gptme is CLI/REST-shaped, NOT a clean library. `gptme.chat()`
drives its own stdout + confirmation loop and returns None (awkward to stream). Two
viable sidecar routes:
  (a) gptme.tools.ToolSpec (fields: name, desc, parameters, execute, ...) to register
      sinain tools, then run gptme.chat(prompt_msgs=[Message("user", msg)],
      no_confirm=True, stream=True, ...) capturing output via gptme hooks; OR
  (b) start `gptme-server` (its REST server) and drive over HTTP — cleaner for a
      resident sidecar.
Then emit the NDJSON protocol (see adapters/subprocess_adapter.py) incl. a leading
{"type":"ready"} line, and wire get_adapter('gptme') to:
  SubprocessAdapter("gptme", cmd=[".venv-gptme/bin/python","sidecars/gptme_sidecar.py"], cwd=_BENCH)
"""
from contract import Adapter


class GptmeAdapter(Adapter):
    name = "gptme"

    async def setup(self) -> None:
        raise NotImplementedError(
            "gptme sidecar not implemented. .venv-gptme is created + gptme installed; "
            "API is CLI/REST-shaped (see module docstring). Implement sidecars/gptme_sidecar.py "
            "then wire SubprocessAdapter.")

    def run(self, message, context):  # pragma: no cover
        raise NotImplementedError

    async def cancel(self) -> None:  # pragma: no cover
        ...
