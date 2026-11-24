import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function make(paths: string[], fill = false) {
  return function Icon({ size = 16, ...rest }: P) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={fill ? "currentColor" : "none"}
        stroke={fill ? "none" : "currentColor"}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </svg>
    );
  };
}

export const IFolder = make(["M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"]);
export const IFile = make(["M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M14 3v5h5"]);
export const IChevron = make(["M9 6l6 6-6 6"]);
export const ISearch = make(["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-3.5-3.5"]);
export const IPlay = make(["M7 5l12 7-12 7z"]);
export const IStop = make(["M7 7h10v10H7z"]);
export const IBranch = make(["M6 4v12", "M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", "M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", "M18 8c0 5-6 4-12 8"]);
export const ICommit = make(["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M3 12h6", "M15 12h6"]);
export const IUpload = make(["M12 16V4", "M7 9l5-5 5 5", "M5 20h14"]);
export const ILink = make(["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"]);
export const IImage = make(["M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4", "M15 9.5a1.5 1.5 0 1 0 0-.01"]);
export const IDoc = make(["M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M9 13h6", "M9 17h6", "M9 9h2"]);
export const ICode = make(["M9 8l-4 4 4 4", "M15 8l4 4-4 4"]);
export const IBox = make(["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M4 7.5l8 4.5 8-4.5", "M12 12v9"]);
export const IInbox = make(["M4 13l2.5-7h11L20 13v6H4z", "M4 13h5l1 2h4l1-2h5"]);
export const ITrash = make(["M5 7h14", "M10 7V5h4v2", "M7 7l1 13h8l1-13"]);
export const ISettings = make(["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"]);
export const IPlug = make(["M9 3v5", "M15 3v5", "M6 8h12v3a6 6 0 0 1-12 0z", "M12 17v4"]);
export const ITerminal = make(["M4 5h16v14H4z", "M7 9l3 3-3 3", "M12 15h5"]);
export const IHistory = make(["M3 12a9 9 0 1 0 3-6.7", "M3 4v4h4", "M12 7v5l3 2"]);
export const IX = make(["M6 6l12 12", "M18 6L6 18"]);
export const ICheck = make(["M5 12l5 5 9-10"]);
export const IPlus = make(["M12 5v14", "M5 12h14"]);
export const IRefresh = make(["M20 11a8 8 0 0 0-14.9-3.5", "M4 4v4h4", "M4 13a8 8 0 0 0 14.9 3.5", "M20 20v-4h-4"]);
export const IExternal = make(["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"]);
export const IPin = make(["M9 4h6l-1 6 3 3H7l3-3z", "M12 16v5"]);
export const IMore = make(["M5 12h.01", "M12 12h.01", "M19 12h.01"]);
export const ICloud = make(["M7 18a4 4 0 0 1-.6-8 6 6 0 0 1 11.6 1.5A3.5 3.5 0 0 1 17.5 18z"]);
export const ILock = make(["M6 11h12v9H6z", "M8 11V8a4 4 0 0 1 8 0v3"]);
export const IPanel = make(["M4 5h16v14H4z", "M15 5v14"]);
export const ISidebar = make(["M4 5h16v14H4z", "M9 5v14"]);
export const ISun = make(["M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M12 2v2", "M12 20v2", "M4.9 4.9l1.4 1.4", "M17.7 17.7l1.4 1.4", "M2 12h2", "M20 12h2", "M4.9 19.1l1.4-1.4", "M17.7 6.3l1.4-1.4"]);
export const IMoon = make(["M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"]);
export const IArchive = make(["M4 5h16v4H4z", "M5 9v10h14V9", "M10 13h4"]);
export const IGit = make(["M12 3l9 9-9 9-9-9z", "M12 8v8", "M12 8a1.5 1.5 0 1 0 0-.01", "M12 16a1.5 1.5 0 1 0 0-.01"]);
export const IDownload = make(["M12 4v12", "M7 11l5 5 5-5", "M5 20h14"]);
export const IEye = make(["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"]);
export const ISpark = make(["M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "M6 6l2.5 2.5", "M15.5 15.5L18 18", "M6 18l2.5-2.5", "M15.5 8.5L18 6"]);
export const IMenu = make(["M4 7h16", "M4 12h16", "M4 17h16"]);
export const IPause = make(["M8 5v14", "M16 5v14"]);
