import type { CheckReport } from './omrClient';
import type { ReadTimings } from './reader';

export interface CheckLine {
  ok: boolean;
  label: string;
  detail: string;
  advice?: string;
}

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** Turn the self-check report into plain lines with advice. Pure. */
export function adviseFromReport(r: CheckReport): CheckLine[] {
  const rep = r.report;
  if (rep.code && !rep.provider) {
    return [
      {
        ok: false,
        label: 'Music reader',
        detail: `${s(rep.error)} (${s(rep.code)})`,
        advice:
          rep.code === 'not_configured'
            ? 'Upload riffi-config.php (or api/config.php) with your GEMINI_API_KEY.'
            : rep.code === 'http_404'
              ? 'api/omr.php is missing: deploy again.'
              : 'Check the server is running PHP 8.1 or newer.',
      },
    ];
  }
  const lines: CheckLine[] = [];
  lines.push({ ok: true, label: 'PHP', detail: `${s(rep.php)} (${s(rep.sapi)}${rep.server ? `, ${s(rep.server)}` : ''})` });
  const met = Number(rep.max_execution_time);
  lines.push({
    ok: met === 0 || met >= 90 || rep.time_limit_settable === true,
    label: 'Time limit',
    detail: `max_execution_time ${met === 0 ? 'unlimited' : `${met} s`}, ${rep.time_limit_settable ? 'can be raised by Riffi' : "can't be raised by Riffi"}`,
    advice: met > 0 && met < 90 && !rep.time_limit_settable ? 'Ask your host (or use the PHP settings in cPanel) to set max_execution_time to 120 or more.' : undefined,
  });
  lines.push({ ok: !!rep.curl, label: 'cURL', detail: rep.curl ? `${s(rep.curl)} ${s(rep.tls)}` : 'missing', advice: rep.curl ? undefined : 'Turn on the PHP curl extension.' });
  lines.push({
    ok: rep.config !== null && rep.config !== undefined,
    label: 'Config file',
    detail: rep.config === 'outside-web-root' ? 'found, outside the web root' : rep.config === 'api-folder' ? 'found in api/ (protected)' : s(rep.config) || 'not found',
  });
  lines.push({ ok: rep.key_set === true, label: 'AI provider', detail: `${s(rep.provider)} · ${s(rep.model)}${rep.key_set ? '' : ' · no key'}`, advice: rep.key_set ? undefined : 'Add the provider key to the config file.' });
  const mc = rep.model_check as { ok?: boolean; status?: number; message?: string } | undefined;
  if (mc) {
    lines.push({
      ok: !!mc.ok,
      label: 'Model',
      detail: mc.ok ? `found${mc.message ? `: ${mc.message}` : ''}` : `${mc.status ? `HTTP ${mc.status}: ` : ''}${s(mc.message)}`,
      advice: mc.ok
        ? undefined
        : mc.status === 404
          ? 'The model name is wrong or retired: set GEMINI_MODEL to a current model (see Google AI Studio).'
          : mc.status === 400 || mc.status === 401 || mc.status === 403
            ? 'The key was refused: check GEMINI_API_KEY (no spaces), or make a new key in Google AI Studio.'
            : mc.status === 0
              ? "The server can't connect out to the AI service. Ask your host to allow outgoing HTTPS to generativelanguage.googleapis.com."
              : undefined,
    });
  }
  const tr = rep.test_request as { ok?: boolean; status?: number; message?: string } | undefined;
  if (tr) {
    lines.push({
      ok: !!tr.ok,
      label: 'Test request',
      detail: tr.ok ? `answered in ${s(tr.message)}` : `HTTP ${s(tr.status)}: ${s(tr.message)}`,
      advice: tr.ok ? undefined : tr.status === 429 ? 'The free tier is out of quota for now: wait a minute (or until tomorrow for the daily limit).' : undefined,
    });
  }
  lines.push({
    ok: r.streamed,
    label: 'Streaming',
    detail: r.streamed
      ? `works (updates arrive as they happen, first after ${r.firstPingMs} ms)`
      : `buffered (everything arrived at once after ${r.totalMs} ms)`,
    advice: r.streamed
      ? undefined
      : 'Something between the server and you holds replies back, so slow pages may hit Cloudflare’s 100-second limit. Turn off any “Rocket Loader” / compression for /api/, or ask the host to disable output buffering for api/omr.php.',
  });
  if (rep.lines_per_request !== undefined) {
    const sec = Number(rep.request_seconds);
    lines.push({
      ok: sec > 0 && sec <= 85,
      label: 'Reading settings',
      detail: `${s(rep.lines_per_request)} line(s) per request, ${s(rep.parallel)} at once, ${sec} s per request, thinking ${s(rep.thinking) || 'model default'}, double-check ${Number(rep.check_rounds) ? `${s(rep.check_rounds)} round(s)` : 'off'}`,
      advice: sec > 85 ? 'Set REQUEST_SECONDS to 60: Cloudflare stops waiting at 100 s.' : undefined,
    });
  }
  const timing = rep.timings as ServerTimings | undefined;
  if (timing) lines.push(...timingLines(timing, Number(rep.request_seconds) || 60));
  lines.push({ ok: !s(rep.log).includes('inside'), label: 'Private log', detail: s(rep.log) || 'off' });
  return lines;
}

/** The self-check's summary of recent requests and reads, from the private log. */
export interface ServerTimings {
  requests?: Record<string, { count: number; ok: number; timeouts: number; avg_s: number; median_s: number; max_s: number }>;
  recent_reads?: { t: string; total_s: number; prep_s: number; heads_s: number; render_s: number; wait_s: number; requests: number; lines: number | null; lines_failed: number | null }[];
}

const MODE_NAMES: Record<string, string> = { overview: 'page overviews', line: 'line reads', check: 'double-checks', page: 'whole pages' };

/** Plain lines about where the time goes. Pure. */
export function timingLines(t: ServerTimings, deadline: number): CheckLine[] {
  const out: CheckLine[] = [];
  const modes = Object.entries(t.requests ?? {});
  if (modes.length) {
    const timeouts = modes.reduce((n, [, m]) => n + m.timeouts, 0);
    out.push({
      ok: timeouts === 0,
      label: 'Recent requests',
      detail: modes.map(([mode, m]) => `${MODE_NAMES[mode] ?? mode}: ${m.count} (median ${m.median_s} s, slowest ${m.max_s} s${m.timeouts ? `, ${m.timeouts} timed out` : ''})`).join('; '),
      advice: timeouts
        ? `Some requests ran past the ${deadline} s deadline. Fewer lines per request (LINES_PER_REQUEST 2 or 3) and GEMINI_THINKING 'low' or 'minimal' keep each one short; a line that times out is now read again on its own.`
        : undefined,
    });
  }
  const last = t.recent_reads?.at(-1);
  if (last) {
    out.push({
      ok: !last.lines_failed,
      label: 'Last read',
      detail: `${last.total_s} s in all: getting photos ready ${last.prep_s} s, measuring note heads ${last.heads_s} s, ${last.requests} requests (waiting for the per-minute limit ${last.wait_s} s), engravings ${last.render_s} s${last.lines_failed ? `; ${last.lines_failed} of ${last.lines} lines couldn't be read` : ''}`,
    });
  }
  return out;
}

/** One sentence about a read on this device. Pure. */
export function timingSummary(t: ReadTimings): string {
  const reqs = t.requests.filter((r) => r.mode === 'line');
  const ms = reqs.map((r) => r.ms).sort((a, b) => a - b);
  const sec = (v: number) => `${(v / 1000).toFixed(1)} s`;
  const parts = [
    `${sec(t.total_ms)} in all`,
    `getting photos ready ${sec(t.prep_ms)}`,
    `measuring note heads ${sec(t.heads_ms)}`,
    `${reqs.length} line requests (${t.lines_per_request} line${t.lines_per_request === 1 ? '' : 's'} each, ${t.parallel} at once${ms.length ? `, median ${sec(ms[Math.floor(ms.length / 2)])}, slowest ${sec(ms[ms.length - 1])}` : ''})`,
  ];
  if (t.render_ms) parts.push(`engravings ${sec(t.render_ms)}`);
  if (t.wait_ms) parts.push(`waiting for the per-minute limit ${sec(t.wait_ms)}`);
  if (t.lines_failed) parts.push(`${t.lines_failed} of ${t.lines} lines couldn't be read`);
  return parts.join(', ') + '.';
}
