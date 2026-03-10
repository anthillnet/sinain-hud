import type { AgentEntry, ContextWindow } from "../types.js";
import type { Recorder } from "../recorder.js";
import type { Escalator } from "../escalation/escalator.js";
import { error } from "../log.js";

const TAG = "core";

export interface TaskDispatcherDeps {
  recorder: Recorder;
  escalator: Escalator;
}

/**
 * Handles agent analysis results: recorder commands + task dispatch via escalator.
 * Extracted from index.ts onAnalysis callback.
 */
export class TaskDispatcher {
  private recorder: Recorder;
  private escalator: Escalator;

  constructor(deps: TaskDispatcherDeps) {
    this.recorder = deps.recorder;
    this.escalator = deps.escalator;
  }

  onAnalysis(entry: AgentEntry, contextWindow: ContextWindow): void {
    // Handle recorder commands
    const stopResult = this.recorder.handleCommand(entry.record);

    // Dispatch task via subagent spawn
    if (entry.task || stopResult) {
      const task = this.buildTask(entry.task, stopResult);

      if (task) {
        this.escalator.dispatchSpawnTask(task, stopResult?.title).catch(err => {
          error(TAG, "spawn task dispatch error:", err);
        });
      }
    }

    // Escalation continues as normal
    this.escalator.onAgentAnalysis(entry, contextWindow);
  }

  private buildTask(
    entryTask: string | undefined,
    stopResult: { title: string; transcript: string; segments: number; durationS: number } | undefined,
  ): string {
    if (stopResult && stopResult.segments > 0 && entryTask) {
      // Recording stopped with explicit task instruction
      return `${entryTask}\n\n[Recording: "${stopResult.title}", ${stopResult.durationS}s]\n${stopResult.transcript}`;
    }

    if (stopResult && stopResult.segments > 0) {
      // Recording stopped without explicit task — default to cleanup/summarize
      return `Clean up and summarize this recording transcript:\n\n[Recording: "${stopResult.title}", ${stopResult.durationS}s]\n${stopResult.transcript}`;
    }

    if (entryTask) {
      // Standalone task without recording
      return entryTask;
    }

    return "";
  }
}
