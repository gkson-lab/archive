import { IBox, IDoc, IImage, ICode, IArchive, ILink, IFolder, IFile, IInbox } from "@archival/ui";
import type { Kind } from "../api";

export function KindIcon({ kind, size = 16 }: { kind: Kind | string; size?: number }) {
  switch (kind) {
    case "project": return <IBox size={size} />;
    case "document": return <IDoc size={size} />;
    case "design": return <IImage size={size} />;
    case "snippet": return <ICode size={size} />;
    case "asset": return <IArchive size={size} />;
    case "link": return <ILink size={size} />;
    case "inbox": return <IInbox size={size} />;
    case "dir": return <IFolder size={size} />;
    default: return <IFile size={size} />;
  }
}

export const CATEGORY_KIND: Record<string, string> = { projects: "project", docs: "document", designs: "design", snippets: "snippet", assets: "asset", links: "link", inbox: "inbox" };
