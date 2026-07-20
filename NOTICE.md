# Third-Party Notices

Sinain's npm, pub, and pip dependencies are installed through their package
managers and retain the licenses distributed with those packages. The
following separately identifiable third-party components are used or bundled
by the product's build and setup paths:

| Component | How it is used | License | Source |
| --- | --- | --- | --- |
| OpenHands Software Agent SDK (`openhands-sdk`) | Installed by pip for `sinain-chat-agent` | MIT | https://github.com/OpenHands/software-agent-sdk |
| whisper.cpp | `whisper-cli` and `whisper-server` are built into the macOS app for local speech transcription | MIT | https://github.com/ggml-org/whisper.cpp |
| Whisper `ggml-large-v3-turbo` model | Downloaded on first use for local transcription; it is not stored in this repository | MIT (model converted from OpenAI Whisper) | https://huggingface.co/ggerganov/whisper.cpp |

The root `skills/sinain-hud` content and `sinain-hud-plugin` are Sinain
components from this repository, not third-party vendored projects. No other
third-party LICENSE, COPYING, or NOTICE files are present under those trees.
