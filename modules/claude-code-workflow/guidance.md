# Claude Code Workflow Guidance

- When starting a non-trivial task, enter plan mode before writing code — the user expects to review a plan first
- Prefer parallel Explore agents over sequential Glob/Grep when scope is uncertain or spans multiple directories
- Before proposing new utilities, search for existing helpers in sinain-koog/common.py and the plugin's helper functions
- When deploying changes, always state which files need SCP and whether a restart is required
- When encountering API failures or timeouts, run /sinain_health to check the retry storm watchdog state before adding retries — if an outage is already detected, back off instead of stacking more calls
- If a hook blocks an action, investigate the hook script in .claude/hooks/ rather than bypassing
- Always run tests (pytest) before declaring a Python change complete
- When modifying the plugin (index.ts), verify by grepping server logs — TypeScript isn't compiled locally
