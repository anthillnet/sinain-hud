"""Open Harness adapter (MIT, TS). Node sidecar. NOTE: npm `open-harness` is at
0.0.1-beta.1 (very immature — confirmed 2026-06-15); treat as a lightweight TS
control over the Vercel AI SDK + MCP, but expect API churn / gaps. Verify the package
identity (MaxGfeller/open-harness) before relying.

Sidecar (sidecars/ts/open_harness_sidecar.mjs): construct the harness with an
OpenRouter-compatible model (AI SDK openai-compatible provider, baseURL=OpenRouter),
register sinain tools (MCP or function tools → sidecars/ts/tools.mjs dispatch), stream
events as NDJSON incl. a leading {"type":"ready"}. Wire:
  SubprocessAdapter("open_harness", cmd=["node","sidecars/ts/open_harness_sidecar.mjs"], cwd=_BENCH)
"""
from contract import Adapter


class OpenHarnessAdapter(Adapter):
    name = "open_harness"

    async def setup(self) -> None:
        raise NotImplementedError(
            "Open Harness sidecar not implemented. npm open-harness is 0.0.1-beta.1 (immature); "
            "verify package identity first. Implement sidecars/ts/open_harness_sidecar.mjs then wire SubprocessAdapter.")

    def run(self, message, context):  # pragma: no cover
        raise NotImplementedError

    async def cancel(self) -> None:  # pragma: no cover
        ...
