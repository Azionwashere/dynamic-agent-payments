import { appendFileSync } from 'node:fs';
import type { AgentEvent, EventCallback } from './types.js';

function getEventFile(): string {
  return process.env.AGENT_PAY_EVENT_FILE || '/tmp/agent-pay-events.jsonl';
}

export function createEventEmitter(): EventCallback {
  return (event: AgentEvent) => {
    const line = JSON.stringify(event) + '\n';
    try {
      appendFileSync(getEventFile(), line);
    } catch {
      // Dashboard is optional — don't crash the MCP server
    }
  };
}

export function emitEvent(
  emit: EventCallback,
  type: string,
  data: Record<string, unknown> = {},
): void {
  emit({
    type,
    timestamp: new Date().toISOString(),
    data,
  });
}
