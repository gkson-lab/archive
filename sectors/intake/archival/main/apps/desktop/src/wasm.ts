// quick runs for single-file snippets without installing anything: js in a worker, python via
// pyodide (webassembly) in a worker. nothing touches the file system.

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";

// the snippet is written straight into the worker script (no eval), wrapped so errors are reported
function jsWorker(code: string) {
  return `
const send = (t, s) => self.postMessage({ t, s });
const fmt = (a) => a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x, null, 2); } catch { return String(x); } })()).join(" ");
console.log = (...a) => send("out", fmt(a) + "\\n");
console.info = console.log;
console.warn = (...a) => send("err", fmt(a) + "\\n");
console.error = console.warn;
self.addEventListener("error", (e) => { send("err", String(e.message) + "\\n"); send("done", "1"); });
(async () => {
${code}
})().then(() => send("done", "0"), (err) => { send("err", String(err && err.stack || err) + "\\n"); send("done", "1"); });
`;
}

const pyWorker = `
importScripts("${PYODIDE}pyodide.js");
let py;
self.onmessage = async (e) => {
  const send = (t, s) => self.postMessage({ t, s });
  try {
    if (!py) {
      send("out", "loading python (webassembly)...\\n");
      py = await loadPyodide({ indexURL: "${PYODIDE}" });
      py.setStdout({ batched: (s) => send("out", s + "\\n") });
      py.setStderr({ batched: (s) => send("err", s + "\\n") });
    }
    await py.loadPackagesFromImports(e.data);
    await py.runPythonAsync(e.data);
    send("done", "0");
  } catch (err) {
    send("err", String(err) + "\\n");
    send("done", "1");
  }
};`;

export function runWasm(lang: "js" | "python", code: string, out: (s: string, err?: boolean) => void, done: (code: number) => void) {
  const src = lang === "js" ? jsWorker(code) : pyWorker;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const w = new Worker(url);
  w.onmessage = (e) => {
    const { t, s } = e.data;
    if (t === "done") done(+s);
    else out(s, t === "err");
  };
  w.onerror = (e) => { out(String(e.message) + "\n", true); done(1); };
  if (lang === "python") w.postMessage(code);
  return { stop: () => { w.terminate(); URL.revokeObjectURL(url); } };
}
