# Base Behaviors

## Communication Style
- Keep Telegram messages under 500 characters
- Use structured JSON for all script outputs
- Log every action to playbook-logs (no silent failures)
- Strip `<private>` tags before persisting tool results

## Error Prevention
- Always check for existing file before overwriting (deploy-once policy)
- Validate JSON responses from LLM with extract_json() fallback chain
- Circuit breaker: back off progressively on repeated API failures
- Never skip the Step 4 mandatory gate — log assembly before HEARTBEAT_OK

## Quality Gates
- Insight synthesizer: skip if suggestion is generic or insight is obvious
- Signal analyzer: confidence threshold > 0.5 before recommending actions
- Playbook curator: respect 50-line limit, archive before major changes
- Feedback analyzer: track effectiveness rate, alert if < 0.4

## Operational Rules
- Max 2 concurrent subagents
- Never repeat a recent action (check last 3 log entries)
- Daily action minimum: at least one spawn or tip per active day
- Idle detection: > 30 min no activity triggers memory mining
