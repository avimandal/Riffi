import { describe, expect, it } from 'vitest';
import { callReader, kindForCode, kindForStatus, readerInfo, type ReaderRequest } from '../../src/sheet/omrClient';
import { adviseFromReport } from '../../src/sheet/readerCheck';

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

describe('one reader request over the stream', () => {
  const req: ReaderRequest = { mode: 'line', images: [{ blob, name: 'line-1-1.jpg' }], fields: { line: 1, lines: 7, key: 2, time: '4/4', pickup: undefined } };
  const call = (f: typeof fetch, provider?: string) => callReader(req, { instrument: 'violin', provider, fetchImpl: f });

  it('sends the mode, fields and image, streams progress and returns the result', async () => {
    let sent: FormData | undefined;
    const bars: number[] = [];
    const res = await callReader(req, {
      instrument: 'violin',
      provider: 'claude',
      onBars: (b) => bars.push(b),
      fetchImpl: (async (_u: string, init: RequestInit) => {
        sent = init.body as FormData;
        return ndjson([{ type: 'start', ref: 'aaa111', pad: '   ' }, { type: 'progress', bars: 1 }, { type: 'ping' }, { type: 'progress', bars: 3 }, { type: 'result', line: { measures: [{ n: 1, s1: 'D5w' }] }, provider: 'claude', ref: 'aaa111' }]);
      }) as unknown as typeof fetch,
    });
    expect(bars).toEqual([1, 3]);
    expect(res).toMatchObject({ line: { measures: [{ n: 1, s1: 'D5w' }] }, provider: 'claude', ref: 'aaa111' });
    expect(sent?.get('mode')).toBe('line');
    expect(sent?.get('provider')).toBe('claude');
    expect(sent?.get('key')).toBe('2');
    expect(sent?.has('pickup')).toBe(false);
    expect((sent?.get('pages[]') as File).name).toBe('line-1-1.jpg');
  });

  it('turns a streamed error into a category with its reference and wait time', async () => {
    const run = call(fakeFetch([() => ndjson([{ type: 'start', ref: 'c0ffee' }, { type: 'error', code: 'busy', message: 'busy', retry_after: 17, ref: 'c0ffee' }])]));
    await expect(run).rejects.toMatchObject({ kind: 'busy', ref: 'c0ffee', code: 'busy', retryAfter: 17 });
  });

  it("treats Cloudflare's HTML 524 as a timeout", async () => {
    const run = call(fakeFetch([() => new Response('<html>A timeout occurred</html>', { status: 524, headers: { 'content-type': 'text/html' } })]));
    await expect(run).rejects.toMatchObject({ kind: 'timeout', code: 'http_524' });
  });

  it('reads our own JSON errors (sent before streaming starts), including the pace wait', async () => {
    const run = call(fakeFetch([() => new Response(JSON.stringify({ error: 'x', code: 'not_configured', ref: 'abc123' }), { status: 500, headers: { 'content-type': 'application/json' } })]));
    await expect(run).rejects.toMatchObject({ kind: 'notConfigured', ref: 'abc123' });
    const paced = call(fakeFetch([() => new Response(JSON.stringify({ error: 'x', code: 'busy', retry_after: 12 }), { status: 429, headers: { 'content-type': 'application/json' } })]));
    await expect(paced).rejects.toMatchObject({ kind: 'busy', retryAfter: 12 });
  });

  it("knows the free tier's daily limit is a different thing", async () => {
    const run = call(fakeFetch([() => ndjson([{ type: 'error', code: 'quota', ref: 'q1' }])]));
    await expect(run).rejects.toMatchObject({ kind: 'quota' });
  });

  it('notices a stream that was cut off before the result', async () => {
    const run = call(fakeFetch([() => ndjson([{ type: 'start', ref: 'dead00' }, { type: 'progress', bars: 3 }], { cut: true })]));
    await expect(run).rejects.toMatchObject({ kind: 'timeout', ref: 'dead00', code: 'stream_cut' });
  });

  it('asks the server which providers are set up', async () => {
    const info = await readerInfo(fakeFetch([() => new Response(JSON.stringify({ providers: ['gemini', 'claude'], default: 'gemini', rpm: { gemini: 8, claude: 40 } }), { headers: { 'content-type': 'application/json' } })]));
    expect(info).toEqual({ providers: ['gemini', 'claude'], default: 'gemini', rpm: { gemini: 8, claude: 40 } });
    expect(await readerInfo(fakeFetch([() => new Response('nope', { status: 404 })]))).toBeNull();
  });

  it('maps every server code to a category', () => {
    expect(['busy', 'quota', 'timeout', 'blocked', 'model_not_found', 'bad_key', 'region', 'unreadable', 'not_configured', 'rate_limited', 'too_big', 'provider_error'].map(kindForCode)).toEqual([
      'busy', 'quota', 'timeout', 'blocked', 'settings', 'settings', 'settings', 'unreadable', 'notConfigured', 'rateLimited', 'tooBig', 'server',
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
