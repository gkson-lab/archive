import { call, bytesToB64, type Item } from "./api";
import { baseName } from "./util";

type Ctx = { track: (id: string, cb?: (j: any) => void) => void; toast: (t: string, k?: "info" | "error", a?: any) => void; fail: (e: unknown) => void; bump: () => void; nav: (r: any) => void };

/** move freshly ingested inbox items to where they were dropped */
async function land(dest: string | null, items: Item[], ctx: Ctx) {
  if (!dest || dest === "inbox") return;
  const parts = dest.split("/");
  for (const it of items) {
    try {
      if (parts.length === 1) await call("item.file", { id: it.id, category: dest });
      else await call("file.rename", { from: it.path, to: `${dest}/${baseName(it.path)}` });
    } catch (e) {
      ctx.fail(e);
    }
  }
  ctx.bump();
}

function done(dest: string | null, ctx: Ctx) {
  return (j: any) => {
    if (j.status !== "done") return;
    const results = Array.isArray(j.result) ? j.result : [j.result];
    const items: Item[] = results.map((r: any) => r?.item).filter(Boolean);
    const dup = results.find((r: any) => r?.duplicate_of);
    if (dup) ctx.toast(`same contents as ${dup.duplicate_of.title}, kept both`, "info");
    land(dest, items, ctx).then(() => {
      if (items.length === 1) {
        const where = dest && dest !== "inbox" ? "" : " in the inbox";
        ctx.toast(`${items[0].title} added${where}`, "info", dest && dest !== "inbox" ? undefined : { label: "triage", run: () => ctx.nav({ view: "inbox" }) });
      } else if (items.length > 1) ctx.toast(`${items.length} things added`);
    });
  };
}

export async function ingestPaths(paths: string[], dest: string | null, ctx: Ctx) {
  if (!paths.length) return;
  try {
    const r = await call<{ job: string }>("ingest.paths", { paths });
    ctx.track(r.job, done(dest, ctx));
  } catch (e) {
    ctx.fail(e);
  }
}

export async function ingestFiles(files: File[], dest: string | null, ctx: Ctx) {
  for (const f of files) {
    if (f.size > 200 * 1024 * 1024) {
      ctx.toast(`${f.name} is over 200 mb. add it with the folder picker instead`, "error");
      continue;
    }
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const r = await call<{ job: string }>("ingest.upload", { name: f.name, base64: bytesToB64(buf) });
      ctx.track(r.job, done(dest, ctx));
    } catch (e) {
      ctx.fail(e);
    }
  }
}

export async function ingestUrl(url: string, ctx: Ctx) {
  try {
    const r = await call<{ job: string }>("ingest.url", { url });
    ctx.track(r.job, done(null, ctx));
  } catch (e) {
    ctx.fail(e);
  }
}
