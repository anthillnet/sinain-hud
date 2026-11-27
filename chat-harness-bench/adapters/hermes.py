"""Hermes agent adapter (NousResearch/hermes-agent, MIT).
install: pip install hermes-agent  (or vendor the repo)

Hermes is more app/gateway than library — likely driven via its API/process. Impl:
  setup(): start a resident Hermes session configured for OpenRouter BENCH_MODEL,
           register sinain tools as MCP + enable bash/file; govern self-learning
           skills (turn off or sandbox for determinism).
  run():   send the message, stream Hermes events → contract.Event.
  cancel(): interrupt the session.
"""
from contract import Adapter


class HermesAdapter(Adapter):
    name = "hermes"

    async def setup(self) -> None:
        raise NotImplementedError("Hermes adapter not implemented yet — see NousResearch/hermes-agent")

    def run(self, message, context):  # pragma: no cover
        raise NotImplementedError

    async def cancel(self) -> None:  # pragma: no cover
        ...
