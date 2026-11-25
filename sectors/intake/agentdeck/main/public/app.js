import { mascot, mascotHtml, poseFor, setPose, setFavicon } from "./mascot.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);

const MODELS = [
  ["", "Default"],
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-haiku-5-5", "Haiku 5.5"],
  ["claude-fable-5-2", "Fable 5.2"],
];
const EFFORTS = [["", "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]];
const WHERE = { local: "This computer", managed: "Cloud · Managed Agents", "claude-cloud": "Cloud · claude.ai" };
const STATUS_TEXT = {
  queued: "Getting ready", starting: "Starting", running: "Working", waiting: "Needs you", idle: "Ready for you",
  done: "Done", error: "Error", stopped: "Stopped", "handed-off": "Handed off",
};
const options = (list, sel = "") => list.map(([v, l]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${l}</option>`).join("");

export function prettyModel(m) {
  if (!m) return "Default model";
  const x = String(m).match(/(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/i);
  if (!x) return m;
  return `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? "." + x[3] : ""}`;
}
const prettyEffort = (e) => (e ? (EFFORTS.find(([v]) => v === e)?.[1] ?? e) : "Default effort");
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(text, pose = "wave") {
  const el = document.createElement("div");
  el.className = "toast";
  el.append(mascot(pose, 3));
  const span = document.createElement("span");
  span.textContent = text;
  el.append(span);
  $("#toasts").append(el);
  setTimeout(() => el.classList.add("out"), 3800);
  setTimeout(() => el.remove(), 4300);
}

// ---------------------------------------------------------------- state

const state = { runs: new Map(), view: "home", runId: null, auth: null, skipGate: false };
const pref = {
  get(k, d) { try { return localStorage.getItem("agentdeck." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("agentdeck." + k, v); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- auth gate

async function refreshAuth(fresh = false) {
  try {
    state.auth = await api("/api/auth" + (fresh ? "?fresh=1" : ""));
  } catch {
    state.auth = { claude: { installed: false, loggedIn: false }, console: { ok: false } };
  }
  const { claude, console: con } = state.auth;
  const signedIn = claude.loggedIn || (state.skipGate && con.ok);
  $("#gate").hidden = signedIn;
  $("#app").hidden = !signedIn;
  $("#gate-missing").hidden = claude.installed;
  $("#login-claude").disabled = !claude.installed;
  $("#login-console").disabled = !claude.installed;
  $("#gate-skip").hidden = !con.ok;
  renderAccount();
  return signedIn;
}

function renderAccount() {
  const a = state.auth;
  if (!a) return;
  const c = a.claude;
  const who = c.email || c.orgName || (c.loggedIn ? "Signed in" : "Not signed in");
  const plan = c.subscriptionType ? ` · ${c.subscriptionType}` : c.authMethod ? ` · ${c.authMethod.replace(/_/g, " ")}` : "";
  $("#account").innerHTML = `
    <div class="acct-row">${mascotHtml(c.loggedIn ? "idle" : "sleep", 2)}
      <div class="acct-text"><div>${esc(who)}<span class="muted">${esc(plan)}</span></div>
      <div class="muted small">Cloud API: ${a.console.ok ? "connected" : "not set up"}</div></div>
    </div>
    <button class="btn ghost small" id="signout">${c.loggedIn ? "Sign out" : "Sign in"}</button>`;
  $("#signout").onclick = async () => {
    if (c.loggedIn) {
      if (!confirm("Sign Claude Code out on this computer? This signs out the claude command everywhere, not just here.")) return;
      await api("/api/auth/logout", { body: {} });
    }
    state.skipGate = false;
    refreshAuth();
  };
}

function setupGate() {
  const gm = mascot("wave", 10, "agentdeck mascot");
  $("#gate-mascot").append(gm);
  const start = async (method) => {
    $("#login-output").hidden = false;
    $("#login-log").textContent = "Opening the sign-in page in your browser…\n";
    setPose(gm, "think");
    try {
      const r = await api("/api/auth/login", { body: { method } });
      if (!r.started) $("#login-log").textContent += r.message + "\n";
    } catch (e) {
      $("#login-log").textContent += e.message + "\n";
    }
  };
  $("#login-claude").onclick = () => start("claudeai");
  $("#login-console").onclick = () => start("console");
  $("#login-check").onclick = async () => {
    if (!(await refreshAuth(true))) {
      setPose(gm, "error");
      setTimeout(() => setPose(gm, "wave"), 1500);
    }
  };
  $("#gate-skip").onclick = () => { state.skipGate = true; refreshAuth(); };
  $("#login-code-form").onsubmit = async (e) => {
    e.preventDefault();
    const code = $("#login-code").value.trim();
    if (!code) return;
    await api("/api/auth/code", { body: { code } }).catch(() => {});
    $("#login-code").value = "";
  };
}

// ---------------------------------------------------------------- live updates

function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("run", (e) => {
    const run = JSON.parse(e.data);
    const prev = state.runs.get(run.id);
    state.runs.set(run.id, run);
    if (prev && prev.status !== run.status) {
      if (run.status === "waiting") toast(`“${run.title}” needs you`, "wait");
      if (run.status === "idle" && prev.status === "running") toast(`“${run.title}” finished its turn`, "done");
      if (run.status === "error") toast(`“${run.title}” hit an error`, "error");
    }
    renderRunList();
    if (state.view === "run" && state.runId === run.id) renderRun();
  });
  es.addEventListener("run-removed", (e) => {
    state.runs.delete(JSON.parse(e.data));
    renderRunList();
  });
  es.addEventListener("auth-log", (e) => {
    const log = $("#login-log");
    log.innerHTML += linkify(JSON.parse(e.data));
    log.scrollTop = log.scrollHeight;
  });
  es.addEventListener("auth-done", async () => {
    if (await refreshAuth(true)) toast("Signed in. Welcome!", "wave");
  });
  es.onerror = () => { /* EventSource reconnects by itself */ };
}

// ---------------------------------------------------------------- navigation

function show(view, runId = null) {
  state.view = view;
  state.runId = runId;
  for (const v of ["home", "run", "roster", "machine"]) $("#view-" + v).hidden = v !== view;
  $$(".nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  renderRunList();
  if (view === "run") { $("#chambers").innerHTML = ""; renderRun(); }
  if (view === "roster") renderRoster();
  if (view === "machine") renderMachine();
  if (view === "home") $("#c-prompt").focus();
  history.replaceState(null, "", view === "run" ? `#run/${runId}` : `#${view}`);
}

function renderRunList() {
  const runs = [...state.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  const list = $("#run-list");
  if (!runs.length) {
    list.innerHTML = `<div class="empty-side">${mascotHtml("sleep", 3)}<span>No agents yet</span></div>`;
    return;
  }
  list.innerHTML = runs
    .map((r) => {
      const subs = r.nodes.length - 1;
      const pose = poseFor(r.status);
      return `<button class="run-item ${state.runId === r.id && state.view === "run" ? "active" : ""}" data-id="${r.id}">
        ${mascotHtml(pose, 2)}
        <span class="ri-text"><span class="ri-title">${esc(r.title)}</span>
        <span class="ri-sub">${r.kind === "local" ? "⌂" : "☁"} ${STATUS_TEXT[r.status] ?? r.status}${subs ? ` · ${subs} subagent${subs > 1 ? "s" : ""}` : ""}</span></span>
      </button>`;
    })
    .join("");
  $$(".run-item", list).forEach((b) => (b.onclick = () => show("run", b.dataset.id)));
}

// ---------------------------------------------------------------- home composer

function setupComposer() {
  $("#c-model").innerHTML = options(MODELS, pref.get("model", ""));
  $("#c-effort").innerHTML = options(EFFORTS, pref.get("effort", ""));
  $("#c-where").value = pref.get("where", "local");
  $("#c-cwd").value = pref.get("cwd", "");
  $("#c-perm").value = pref.get("perm", "acceptEdits");

  const sync = () => {
    const where = $("#c-where").value;
    $$("#composer [data-for]").forEach((el) => (el.hidden = !el.dataset.for.split(" ").includes(where)));
    $("#c-hint").textContent = {
      local: "Runs with Claude Code on this computer, signed in as you. Subagents show up live, each in its own chamber.",
      managed: "Runs in an Anthropic-hosted sandbox (beta). Needs an Anthropic API key or `ant auth login`, billed to your Console organization.",
      "claude-cloud": "Opens a terminal running `claude --cloud`, which starts a session on claude.ai/code under your Claude account.",
    }[where];
    // Managed Agents needs a full model id.
    const def = $("#c-model").options[0];
    def.textContent = where === "managed" ? "Opus 5.5 (default)" : "Default";
  };
  $("#c-where").onchange = () => { pref.set("where", $("#c-where").value); sync(); };
  sync();
  loadAgentPicker();
  $("#c-cwd").onchange = () => { pref.set("cwd", $("#c-cwd").value); loadAgentPicker(); };

  $("#c-prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#composer").requestSubmit();
  });
  $("#composer").onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      where: $("#c-where").value,
      prompt: $("#c-prompt").value,
      cwd: $("#c-cwd").value,
      model: $("#c-model").value,
      effort: $("#c-effort").value,
      agent: $("#c-agent").value,
      permissionMode: $("#c-perm").value,
    };
    pref.set("model", body.model);
    pref.set("effort", body.effort);
    pref.set("perm", body.permissionMode);
    const btn = $("#composer .send");
    btn.disabled = true;
    try {
      const run = await api("/api/runs", { body });
      state.runs.set(run.id, run);
      $("#c-prompt").value = "";
      $("#c-agent").value = "";
      toast(run.kind === "claude-cloud" ? "Handed off to claude.ai" : "Agent started", run.kind === "claude-cloud" ? "wave" : "work");
      show("run", run.id);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  };
}

async function loadAgentPicker() {
  try {
    const defs = await api("/api/roster?cwd=" + encodeURIComponent($("#c-cwd").value));
    const sel = $("#c-agent");
    const cur = sel.value;
    sel.innerHTML = `<option value="">Claude Code (default)</option>` + defs.filter((d) => d.source !== "built-in").map((d) => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join("");
    sel.value = cur;
  } catch { /* roster is optional */ }
}

// ---------------------------------------------------------------- run view: one chamber per agent

function renderRun() {
  const run = state.runs.get(state.runId);
  if (!run) { show("home"); return; }

  const rm = $("#run-mascot");
  if (!rm.firstChild) rm.append(mascot(poseFor(run.status), 5));
  setPose(rm.firstChild, poseFor(run.status));
  $("#run-title").textContent = run.title;
  const subs = run.nodes.length - 1;
  $("#run-meta").innerHTML = [
    `<span class="pill s-${run.status}">${STATUS_TEXT[run.status] ?? run.status}</span>`,
    esc(WHERE[run.kind]),
    run.cwd ? `<code>${esc(run.cwd)}</code>` : "",
    `${subs} subagent${subs === 1 ? "" : "s"}`,
    run.costUsd ? `$${run.costUsd.toFixed(3)}` : "",
    `started ${ago(run.createdAt)} ago`,
  ].filter(Boolean).join(" · ");
  const link = $("#run-link");
  link.hidden = !run.url;
  if (run.url) link.href = run.url;
  const active = ["running", "starting", "waiting"].includes(run.status);
  $("#run-stop").hidden = !active || run.kind === "claude-cloud";
  $("#run-done").hidden = active || ["done", "handed-off"].includes(run.status);
  $("#run-stop").onclick = () => api(`/api/runs/${run.id}/stop`, { body: {} }).catch((e) => toast(e.message, "error"));
  $("#run-done").onclick = () => api(`/api/runs/${run.id}/done`, { body: {} });
  $("#run-remove").onclick = async () => {
    if (!confirm("Remove this agent from agentdeck? A running agent is stopped first. Its Claude session itself is kept.")) return;
    await api(`/api/runs/${run.id}`, { method: "DELETE" });
    state.runs.delete(run.id);
    show("home");
  };
  const err = $("#run-error");
  err.hidden = !run.error || run.status !== "error";
  err.textContent = run.error ?? "";

  const host = $("#chambers");
  for (const n of run.nodes) {
    let el = host.querySelector(`.chamber-wrap[data-node="${CSS.escape(n.id)}"]`);
    if (!el) el = buildChamber(run, n);
    const parent = n.parentId ? host.querySelector(`.chamber-wrap[data-node="${CSS.escape(n.parentId)}"] > .kids`) : host;
    const target = parent ?? host.querySelector(`.chamber-wrap[data-node="root"] > .kids`) ?? host;
    if (el.parentElement !== target) target.append(el);
    updateChamber(run, n, el);
  }
}

function buildChamber(run, n) {
  const wrap = document.createElement("div");
  wrap.className = "chamber-wrap" + (n.id === "root" ? " root" : "");
  wrap.dataset.node = n.id;
  const isRoot = n.id === "root";
  const canTalk = run.kind !== "claude-cloud";
  wrap.innerHTML = `
    <article class="chamber">
      <div class="ch-head">
        <div class="ch-avatar"></div>
        <div class="ch-id">
          <div class="ch-name"></div>
          <div class="ch-desc muted"></div>
        </div>
        <span class="pill ch-status"></span>
      </div>
      <div class="ch-chips"></div>
      <div class="ch-pending"></div>
      <div class="ch-feed" tabindex="0" aria-label="Activity"></div>
      ${canTalk ? `
      <form class="ch-talk">
        <textarea rows="1" placeholder="${isRoot ? "Talk to the main agent…" : `Talk to ${esc(n.name)}…`}"></textarea>
        <div class="ch-talk-bar">
          ${isRoot && run.kind === "local"
            ? `<select class="t-model" title="Model for your next message">${options(MODELS, run.model ?? "")}</select>
               <select class="t-effort" title="Effort for your next message">${options(EFFORTS, run.effort ?? "")}</select>`
            : `<span class="muted small">${isRoot ? "Model and effort are fixed for this cloud agent" : "Relayed through the main agent"}</span>`}
          <button class="btn primary small">Send</button>
        </div>
      </form>` : ""}
    </article>
    <div class="kids"></div>`;
  wrap.querySelector(".ch-avatar").append(mascot(poseFor(n.status), 4, n.name));
  const form = wrap.querySelector(".ch-talk");
  if (form) {
    const ta = form.querySelector("textarea");
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      const body = { text, nodeId: n.id };
      const m = form.querySelector(".t-model"), ef = form.querySelector(".t-effort");
      if (m?.value) body.model = m.value;
      if (ef?.value) body.effort = ef.value;
      ta.value = "";
      ta.style.height = "auto";
      try {
        await api(`/api/runs/${run.id}/talk`, { body });
      } catch (err) {
        ta.value = text;
        toast(err.message, "error");
      }
    };
  }
  return wrap;
}

function updateChamber(run, n, wrap) {
  const isRoot = n.id === "root";
  setPose(wrap.querySelector(".ch-avatar .clawd"), poseFor(n.status));
  wrap.querySelector(".ch-name").textContent = isRoot ? (run.agent && run.agent !== "main" ? run.agent : "Main agent") : n.name;
  wrap.querySelector(".ch-desc").textContent = isRoot ? (run.kind === "managed" ? "Coordinator · cloud sandbox" : run.kind === "claude-cloud" ? "claude.ai/code" : "Claude Code · this computer") : n.description;
  const st = wrap.querySelector(".ch-status");
  st.className = `pill ch-status s-${n.status}`;
  st.textContent = STATUS_TEXT[n.status] ?? n.status;
  wrap.classList.toggle("live", n.status === "running" || n.status === "waiting");

  const chips = [
    `<span class="chip model" title="Model">◆ ${esc(prettyModel(n.model ?? (isRoot ? run.model : "")))}</span>`,
    `<span class="chip effort" title="Effort">${effortBars(n.effort ?? (isRoot ? run.effort : ""))} ${esc(prettyEffort(n.effort ?? (isRoot ? run.effort : "")))}</span>`,
    `<span class="chip">${n.toolUses} tool use${n.toolUses === 1 ? "" : "s"}</span>`,
    n.tokens ? `<span class="chip">${(n.tokens / 1000).toFixed(1)}k tokens</span>` : "",
    `<span class="chip">${ago(n.startedAt)}${n.endedAt ? ` · took ${Math.max(1, Math.round((n.endedAt - n.startedAt) / 1000))}s` : ""}</span>`,
    isRoot && run.queue?.length ? `<span class="chip warn">${run.queue.length} queued</span>` : "",
  ];
  wrap.querySelector(".ch-chips").innerHTML = chips.join("");

  // Approvals (Managed Agents) show in the chamber that asked; the root shows any without a home.
  const pend = isRoot ? run.pending ?? [] : [];
  wrap.querySelector(".ch-pending").innerHTML = pend
    .map((p) => `<div class="approval">${mascotHtml("wait", 2)}<div><b>${esc(p.name)}</b> wants to run<pre>${esc(p.input)}</pre></div>
      <div class="row"><button class="btn primary small" data-allow="${esc(p.toolUseId)}">Allow</button><button class="btn ghost small" data-deny="${esc(p.toolUseId)}">Deny</button></div></div>`)
    .join("");
  $$("[data-allow],[data-deny]", wrap.querySelector(".ch-pending")).forEach((b) => {
    b.onclick = () => api(`/api/runs/${run.id}/confirm`, { body: { toolUseId: b.dataset.allow ?? b.dataset.deny, allow: !!b.dataset.allow } }).catch((e) => toast(e.message, "error"));
  });

  const feed = wrap.querySelector(".ch-feed");
  const entries = run.log.filter((l) => l.nodeId === n.id);
  if (feed._count !== entries.length || feed._status !== n.status) {
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    const shown = entries.slice(-120);
    feed.innerHTML =
      (!isRoot && n.prompt && !entries.some((e) => e.kind === "user") ? `<div class="msg brief"><span class="tag">Task</span>${linkify(n.prompt.slice(0, 1200))}</div>` : "") +
      (shown.length
        ? shown.map((l) => `<div class="msg k-${l.kind}">${l.kind === "user" ? '<span class="tag">You</span>' : l.kind === "result" ? '<span class="tag">Report</span>' : ""}${linkify(l.text)}</div>`).join("")
        : `<div class="feed-empty">${mascotHtml(poseFor(n.status), 3)}<span>${n.status === "running" ? "Working on it…" : "Nothing yet"}</span></div>`) +
      (n.status === "running" && shown.length ? `<div class="msg typing">${mascotHtml("work", 2)}<span>${esc(n.lastAction ?? "thinking")}</span></div>` : "");
    if (atBottom || feed._count === undefined) feed.scrollTop = feed.scrollHeight;
    feed._count = entries.length;
    feed._status = n.status;
  }
}

function effortBars(e) {
  const lvl = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }[e] ?? 0;
  return `<span class="bars" aria-hidden="true">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= lvl ? "on" : ""}"></i>`).join("")}</span>`;
}

// ---------------------------------------------------------------- roster & machine

async function renderRoster() {
  const box = $("#roster");
  const cwdInput = $("#roster-cwd");
  if (!cwdInput.value) cwdInput.value = pref.get("cwd", "");
  cwdInput.onchange = renderRoster;
  box.innerHTML = `<div class="loading">${mascotHtml("think", 4)}</div>`;
  try {
    const defs = await api("/api/roster?cwd=" + encodeURIComponent(cwdInput.value));
    box.innerHTML = defs
      .map((d) => `<article class="card">
        <div class="card-head">${mascotHtml("idle", 4)}<div><div class="card-title">${esc(d.name)}</div><div class="muted small">${esc(d.source)}</div></div></div>
        <p>${esc(d.description || "No description.")}</p>
        <div class="ch-chips"><span class="chip model">◆ ${esc(d.model && d.model !== "inherit" ? prettyModel(d.model) : "Inherits model")}</span>
        <span class="chip effort">${effortBars(d.effort)} ${esc(d.effort ? prettyEffort(d.effort) : "Inherits effort")}</span>
        ${d.tools ? `<span class="chip">tools: ${esc(d.tools)}</span>` : ""}</div>
        ${d.source !== "built-in" ? `<button class="btn small" data-dispatch="${esc(d.name)}">Start as main agent</button>` : `<span class="muted small">Your agents call this one when they need it.</span>`}
      </article>`)
      .join("");
    $$("[data-dispatch]", box).forEach((b) => (b.onclick = async () => {
      show("home");
      $("#c-where").value = "local";
      $("#c-where").onchange();
      $("#c-cwd").value = cwdInput.value;
      await loadAgentPicker();
      $("#c-agent").value = b.dataset.dispatch;
      $("#c-prompt").focus();
    }));
  } catch (e) {
    box.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
  }
}

let machineTimer;
async function renderMachine() {
  clearTimeout(machineTimer);
  if (state.view !== "machine") return;
  const box = $("#machine");
  try {
    const data = await api("/api/machine");
    const sessions = data.sessions ?? [];
    if (!data.installed) box.innerHTML = `<div class="notice">The <code>claude</code> command isn't installed here.</div>`;
    else if (!sessions.length) box.innerHTML = `<div class="feed-empty big">${mascotHtml("sleep", 6)}<span>No Claude Code sessions are running on this computer.</span></div>`;
    else
      box.innerHTML = sessions
        .map((s) => {
          const status = s.status === "busy" ? "running" : s.status === "waiting" ? "waiting" : s.status === "idle" ? "idle" : s.status ?? "idle";
          return `<article class="card">
            <div class="card-head">${mascotHtml(poseFor(status), 4)}<div><div class="card-title">${esc(s.name ?? s.sessionId?.slice(0, 8) ?? "session")}</div>
            <div class="muted small">${esc(s.kind ?? "")}${s.pid ? ` · pid ${esc(s.pid)}` : ""}</div></div>
            <span class="pill s-${status}">${esc(STATUS_TEXT[status] ?? s.status ?? "")}</span></div>
            <p><code>${esc(s.cwd ?? "")}</code></p>
            <div class="muted small">${s.startedAt ? `started ${ago(s.startedAt)} ago` : ""}${s.sessionId ? ` · ${esc(s.sessionId)}` : ""}</div>
          </article>`;
        })
        .join("");
  } catch (e) {
    box.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
  }
  machineTimer = setTimeout(renderMachine, 5000);
}

// ---------------------------------------------------------------- mascots wandering around

function wanderer(stage, scale) {
  const m = mascot("walk", scale);
  m.classList.add("wanderer");
  stage.append(m);
  let x = 0;
  const acts = ["work", "think", "wave", "sleep", "idle", "done"];
  const step = () => {
    const width = stage.clientWidth - 12 * scale;
    if (width <= 0) return setTimeout(step, 1000);
    // Move in whole sprite pixels (steps), never through fractional positions that would smear the art.
    const to = Math.round((Math.random() * width) / scale) * scale;
    const dist = Math.abs(to - x);
    m.style.transition = `transform ${dist * 18}ms steps(${Math.max(1, Math.round(dist / scale))}, end)`;
    m.classList.toggle("flip", to < x);
    setPose(m, "walk");
    m.style.transform = `translateX(${to}px)`;
    x = to;
    setTimeout(() => {
      setPose(m, acts[Math.floor(Math.random() * acts.length)]);
      setTimeout(step, 2200 + Math.random() * 2600);
    }, dist * 18);
  };
  step();
}

// ---------------------------------------------------------------- start

async function main() {
  setFavicon();
  const desktop = new URLSearchParams(location.search).get("desktop");
  if (desktop) document.documentElement.classList.add("desktop", "desktop-" + desktop);
  if (/Win/i.test(navigator.platform)) $("#install-cmd").textContent = "irm https://claude.ai/install.ps1 | iex";
  $("#brand-mascot").append(mascot("idle", 3, "agentdeck"));
  setupGate();
  setupComposer();
  $("#nav-new").onclick = () => show("home");
  $$(".nav-item[data-view]").forEach((b) => (b.onclick = () => show(b.dataset.view)));

  const runs = await api("/api/runs").catch(() => []);
  for (const r of runs) state.runs.set(r.id, r);
  connect();
  await refreshAuth();

  wanderer($("#home-walker"), 6);
  wanderer($("#ground-walker"), 3);

  const [view, id] = location.hash.slice(1).split("/");
  if (view === "run" && state.runs.has(id)) show("run", id);
  else if (["roster", "machine"].includes(view)) show(view);
  else show("home");

  setInterval(() => { if (state.view === "run") renderRun(); renderRunList(); }, 15000);
}
main();
