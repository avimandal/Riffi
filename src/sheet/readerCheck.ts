import type { CheckReport } from './omrClient';

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
  lines.push({ ok: !s(rep.log).includes('inside'), label: 'Private log', detail: s(rep.log) || 'off' });
  return lines;
}
