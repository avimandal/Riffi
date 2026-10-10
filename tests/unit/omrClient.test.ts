import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kindForCode, kindForStatus, OmrError, readSheetMusic } from '../../src/sheet/omrClient';
import { adviseFromReport } from '../../src/sheet/readerCheck';
import { parseMusicXml } from '../../src/sheet/musicxml';
import type { RnScore } from '../../src/sheet/notation';

const hornpipe = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/sheets/hermans-hornpipe.rn.json'), 'utf8')) as RnScore;

/** A Response that streams NDJSON lines in small, uneven chunks (like a real proxy). */
function ndjson(lines: object[], opts: { cut?: boolean } = {}): Response {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + (opts.cut ? '' : '\n');
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({
    start(ctl) {
      for (let i = 0; i < bytes.length; i += 97) ctl.enqueue(bytes.slice(i, i + 97));
      ctl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
}

function fakeFetch(responses: (() => Response)[]): typeof fetch {
  let i = 0;
  return (async () => responses[i++]()) as unknown as typeof fetch;
}

const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });

describe('reading pages over the stream', () => {
  it('reads two pages one request at a time, reports progress, and builds MusicXML', async () => {
    const page1 = { ...hornpipe, measures: hornpipe.measures.slice(0, 11), warnings: undefined };
    const page2 = { measures: hornpipe.measures.slice(11) };
    const progress: string[] = [];
    const res = await readSheetMusic(
      [blob, blob],
      'violin',
      (p) => progress.push(`${p.page + 1}/${p.pages}:${p.stage}:${p.bars}`),
      fakeFetch([
        () => ndjson([{ type: 'start', ref: 'aaa111', pad: '   ' }, { type: 'progress', bars: 5 }, { type: 'ping' }, { type: 'progress', bars: 11 }, { type: 'result', score: page1, warnings: ['Bar 4: smudge'], ref: 'aaa111' }]),
        () => ndjson([{ type: 'start', ref: 'bbb222' }, { type: 'progress', bars: 11 }, { type: 'result', score: page2, warnings: [], ref: 'bbb222' }]),
      ]),
    );
    expect(progress).toEqual(['1/2:sending:0', '1/2:reading:0', '1/2:reading:5', '1/2:reading:11', '2/2:sending:0', '2/2:reading:0', '2/2:reading:11']);
    const s = parseMusicXml(res.musicxml);
    expect(s.measures).toHaveLength(22);
    expect(s.title).toBe("Herman's hornpipe");
    expect(res.warnings).toEqual(['Bar 4: smudge']);
  });

  it('turns a streamed error into a category with its reference', async () => {
    const run = readSheetMusic([blob], 'violin', undefined, fakeFetch([() => ndjson([{ type: 'start', ref: 'c0ffee' }, { type: 'error', code: 'busy', message: 'busy', ref: 'c0ffee' }])]));
    await expect(run).rejects.toMatchObject({ kind: 'busy', ref: 'c0ffee', code: 'busy' });
  });

  it("treats Cloudflare's HTML 524 as a timeout", async () => {
    const run = readSheetMusic([blob], 'violin', undefined, fakeFetch([() => new Response('<html>A timeout occurred</html>', { status: 524, headers: { 'content-type': 'text/html' } })]));
    await expect(run).rejects.toMatchObject({ kind: 'timeout', code: 'http_524' });
  });

  it('reads our own JSON errors (sent before streaming starts)', async () => {
    const run = readSheetMusic([blob], 'violin', undefined, fakeFetch([() => new Response(JSON.stringify({ error: 'x', code: 'not_configured', ref: 'abc123' }), { status: 500, headers: { 'content-type': 'application/json' } })]));
    await expect(run).rejects.toMatchObject({ kind: 'notConfigured', ref: 'abc123' });
  });

  it('notices a stream that was cut off before the result', async () => {
    const run = readSheetMusic([blob], 'violin', undefined, fakeFetch([() => ndjson([{ type: 'start', ref: 'dead00' }, { type: 'progress', bars: 3 }], { cut: true })]));
    await expect(run).rejects.toMatchObject({ kind: 'timeout', ref: 'dead00', code: 'stream_cut' });
  });

  it('rejects a result the app cannot use', async () => {
    const run = readSheetMusic([blob], 'violin', undefined, fakeFetch([() => ndjson([{ type: 'result', score: { measures: [{ s1: 'Q9' }] } }])]));
    await expect(run).rejects.toBeInstanceOf(OmrError);
  });

  it('maps every server code to a category', () => {
    expect(['busy', 'timeout', 'blocked', 'model_not_found', 'bad_key', 'region', 'unreadable', 'not_configured', 'rate_limited', 'too_big', 'provider_error'].map(kindForCode)).toEqual([
      'busy', 'timeout', 'blocked', 'settings', 'settings', 'settings', 'unreadable', 'notConfigured', 'rateLimited', 'tooBig', 'server',
    ]);
    expect([413, 429, 502, 504, 522, 524].map(kindForStatus)).toEqual(['tooBig', 'rateLimited', 'server', 'timeout', 'timeout', 'timeout']);
  });
});

describe('Check music reader advice', () => {
  const base = {
    php: '8.2.27', sapi: 'litespeed', server: 'LiteSpeed', max_execution_time: 30, time_limit_settable: false,
    curl: '8.5.0', tls: 'OpenSSL/3.0', config: 'outside-web-root', provider: 'gemini', model: 'gemini-flash-latest', key_set: true,
    log: 'riffi-logs/omr.log (outside the web root)',
  };

  it('spots the classic shared-hosting problems', () => {
    const lines = adviseFromReport({ report: { ...base, model_check: { ok: false, status: 404, message: 'not found' } }, streamed: false, totalMs: 1700 });
    const bad = lines.filter((l) => !l.ok).map((l) => l.label);
    expect(bad).toEqual(['Time limit', 'Model', 'Streaming']);
    expect(lines.find((l) => l.label === 'Model')?.advice).toMatch(/GEMINI_MODEL/);
  });

  it('is all green on a healthy server', () => {
    const lines = adviseFromReport({
      report: { ...base, max_execution_time: 0, model_check: { ok: true, status: 200, message: 'Gemini Flash' }, test_request: { ok: true, status: 200, message: '812 ms' } },
      streamed: true,
      firstPingMs: 640,
      totalMs: 2500,
    });
    expect(lines.every((l) => l.ok)).toBe(true);
  });

  it('explains a missing endpoint or config', () => {
    expect(adviseFromReport({ report: { code: 'not_configured', error: 'The music reader is not set up yet.' }, streamed: false, totalMs: 10 })[0].advice).toMatch(/GEMINI_API_KEY/);
  });
});
