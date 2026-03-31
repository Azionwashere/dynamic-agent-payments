import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { createEventEmitter, emitEvent } from '../src/lib/events.js';

const TEST_EVENT_FILE = '/tmp/agent-pay-events-test.jsonl';

describe('events', () => {
  beforeEach(() => {
    process.env.AGENT_PAY_EVENT_FILE = TEST_EVENT_FILE;
    if (existsSync(TEST_EVENT_FILE)) unlinkSync(TEST_EVENT_FILE);
    writeFileSync(TEST_EVENT_FILE, ''); // ensure file exists
  });

  afterEach(() => {
    if (existsSync(TEST_EVENT_FILE)) unlinkSync(TEST_EVENT_FILE);
    delete process.env.AGENT_PAY_EVENT_FILE;
  });

  it('emits events as JSONL to the event file', () => {
    const emit = createEventEmitter();
    emitEvent(emit, 'test_event', { key: 'value' });

    const content = readFileSync(TEST_EVENT_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('test_event');
    expect(parsed.data.key).toBe('value');
    expect(parsed.timestamp).toBeDefined();
  });

  it('appends multiple events', () => {
    const emit = createEventEmitter();
    emitEvent(emit, 'event_1', { n: 1 });
    emitEvent(emit, 'event_2', { n: 2 });
    emitEvent(emit, 'event_3', { n: 3 });

    const content = readFileSync(TEST_EVENT_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).type).toBe('event_1');
    expect(JSON.parse(lines[2]).type).toBe('event_3');
  });

  it('does not crash when file write fails', () => {
    process.env.AGENT_PAY_EVENT_FILE = '/nonexistent/path/events.jsonl';
    const emit = createEventEmitter();
    // Should not throw
    expect(() => emitEvent(emit, 'test', {})).not.toThrow();
  });
});
