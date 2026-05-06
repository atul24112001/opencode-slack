import { describe, expect, it } from 'vitest';
import { parseLine } from '../../src/opencode.js';

const STEP_START =
  '{"type":"step_start","timestamp":1778058926932,"sessionID":"ses_abc","part":{"id":"prt_1","messageID":"msg_1","sessionID":"ses_abc","type":"step-start"}}';

const TEXT =
  '{"type":"text","timestamp":1778058928117,"sessionID":"ses_abc","part":{"id":"prt_2","messageID":"msg_1","sessionID":"ses_abc","type":"text","text":"Hello world","time":{"start":1778058927999,"end":1778058928115}}}';

const TOOL_USE =
  '{"type":"tool_use","timestamp":1778059068498,"sessionID":"ses_abc","part":{"type":"tool","tool":"bash","callID":"call_1","state":{"status":"completed","input":{"command":"ls","description":"Lists files in current directory"},"output":"foo.txt\\n","title":"Lists files in current directory","time":{"start":1778059068489,"end":1778059068495}},"id":"prt_3","sessionID":"ses_abc","messageID":"msg_1"}}';

const STEP_FINISH =
  '{"type":"step_finish","timestamp":1778058928121,"sessionID":"ses_abc","part":{"id":"prt_4","reason":"stop","messageID":"msg_1","sessionID":"ses_abc","type":"step-finish","tokens":{"total":10482,"input":10450,"output":2,"reasoning":30,"cache":{"write":0,"read":0}},"cost":0.01829436}}';

describe('parseLine', () => {
  it('returns null on invalid JSON', () => {
    expect(parseLine('not json')).toBeNull();
    expect(parseLine('Shell cwd was reset to /tmp')).toBeNull();
  });

  it('returns null on JSON that is not an object', () => {
    expect(parseLine('123')).toBeNull();
    expect(parseLine('"string"')).toBeNull();
    expect(parseLine('null')).toBeNull();
  });

  it('parses step_start: type + sessionID', () => {
    const e = parseLine(STEP_START)!;
    expect(e.type).toBe('step_start');
    expect(e.sessionId).toBe('ses_abc');
    expect(e.text).toBeUndefined();
  });

  it('extracts part.text on text events', () => {
    const e = parseLine(TEXT)!;
    expect(e.type).toBe('text');
    expect(e.text).toBe('Hello world');
    expect(e.sessionId).toBe('ses_abc');
  });

  it('extracts part.tool, part.state.title on tool_use events', () => {
    const e = parseLine(TOOL_USE)!;
    expect(e.type).toBe('tool_use');
    expect(e.toolName).toBe('bash');
    expect(e.toolDescription).toBe('Lists files in current directory');
  });

  it('extracts part.tokens.total + part.cost on step_finish', () => {
    const e = parseLine(STEP_FINISH)!;
    expect(e.type).toBe('step_finish');
    expect(e.tokens).toBe(10482);
    expect(e.costUsd).toBeCloseTo(0.01829436);
  });

  it('does not crash when part is missing', () => {
    const e = parseLine('{"type":"unknown"}')!;
    expect(e.type).toBe('unknown');
    expect(e.text).toBeUndefined();
    expect(e.tokens).toBeUndefined();
  });
});
