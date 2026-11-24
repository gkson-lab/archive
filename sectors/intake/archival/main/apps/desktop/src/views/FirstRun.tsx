import { useState } from "react";
import { useApp } from "../state";
import { Button, Field } from "@archival/ui";
import { pickPaths } from "../platform";
import { ingestFiles, ingestPaths } from "../ingest";
import { inApp } from "../api";

/** no tour. one drop zone. people learn the vault by putting something in it. */
export function FirstRun({ onSkip }: { onSkip: () => void }) {
  const app = useApp();
  const [over, setOver] = useState(false);
  const [path, setPath] = useState("");
  return (
    <div
      className={`first-run ${over ? "over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = Array.from(e.dataTransfer.files); if (f.length) ingestFiles(f, null, app); }}
      data-drop-path="inbox"
    >
      <div className="fr-zone">
        <h1>drop a folder to start your vault.</h1>
        <p className="muted">a project, a pile of docs, a design export. it lands in the inbox with a suggested place.</p>
        <div className="row gap wrap center">
          {inApp ? (
            <Button variant="primary" onClick={async () => { const p = await pickPaths({ directory: true, multiple: true }); if (p) ingestPaths(p, null, app); }}>pick a folder</Button>
          ) : (
            <form className="row gap" onSubmit={(e) => { e.preventDefault(); if (path.trim()) ingestPaths([path.trim()], null, app); }}>
              <Field label="or type a folder path"><input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/code/project" /></Field>
              <Button variant="primary" type="submit" disabled={!path.trim()}>add it</Button>
            </form>
          )}
          <Button variant="ghost" onClick={onSkip}>skip for now</Button>
        </div>
      </div>
    </div>
  );
}
