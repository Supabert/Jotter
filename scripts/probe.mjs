// One-off CDP probe: run an expression in the live app and print the result.
const PORT = Number(process.env.JOTTER_CDP_PORT ?? 9333);
const expr = process.argv[2];
let seq = 0;
const pending = new Map();

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let ws;
for (const p of list.filter((t) => t.type === 'page' && t.url.startsWith('http'))) {
  const sock = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { sock.onopen = ok; sock.onerror = bad; });
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const q = pending.get(m.id);
    if (q) { pending.delete(m.id); m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result); }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { resolve: res, reject: rej });
    sock.send(JSON.stringify({ id, method, params }));
  });
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { return !!document.querySelector('.app'); })()`,
    awaitPromise: true, returnByValue: true
  });
  if (r.result.value) { ws = { sock, send }; break; }
  sock.close();
}
if (!ws) { console.error('no main window'); process.exit(1); }

const r = await ws.send('Runtime.evaluate', {
  expression: `(async () => { ${expr} })()`,
  awaitPromise: true, returnByValue: true
});
if (r.exceptionDetails) console.error(r.exceptionDetails.exception?.description ?? 'threw');
else console.log(JSON.stringify(r.result.value, null, 2));
ws.sock.close();
process.exit(0);
