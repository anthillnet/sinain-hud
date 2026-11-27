"""Cline SDK adapter (Apache-2.0, TS). Node sidecar in sidecars/ts (@cline/sdk@0.0.47
installed). TS control to quantify in-process-TS vs Python-sidecar cost.

API shape discovered: `import { Agent } from "@cline/sdk"`; Agent is a class with
methods run / continue / abort / subscribe / restore / snapshot / initialize /
registerHooks. `subscribe` is the event stream; `run(task)` starts a turn; `abort`
cancels. The constructor config (providerId/modelId/apiKey/baseURL/tools) is NOT in
the shipped d.ts/README (dist is bundled) — needs decompiling dist or the GitHub SDK
docs to wire OpenRouter + sinain tools. Sidecar (sidecars/ts/cline_sidecar.mjs):
  const agent = new Agent({ provider/model config for OpenRouter, tools=[sinain...] })
  agent.subscribe(ev => emit NDJSON token/tool_call/tool_result)
  // map sinain tools to Cline tool descriptors; tools call sidecars/ts/tools.mjs dispatch
Emit {"type":"ready"} on boot. Wire:
  SubprocessAdapter("cline", cmd=["node","sidecars/ts/cline_sidecar.mjs"], cwd=_BENCH)
"""
from contract import Adapter


class ClineAdapter(Adapter):
    name = "cline"

    async def setup(self) -> None:
        raise NotImplementedError(
            "Cline sidecar not implemented. @cline/sdk installed in sidecars/ts; Agent API "
            "is run/continue/abort/subscribe but constructor config isn't in shipped types "
            "(see module docstring). Implement sidecars/ts/cline_sidecar.mjs then wire SubprocessAdapter.")

    def run(self, message, context):  # pragma: no cover
        raise NotImplementedError

    async def cancel(self) -> None:  # pragma: no cover
        ...
