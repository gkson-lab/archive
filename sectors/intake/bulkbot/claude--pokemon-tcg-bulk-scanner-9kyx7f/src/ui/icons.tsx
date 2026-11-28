// Inline SVG icons (stroke style, inherit currentColor).
import type { JSX } from 'preact';

type P = JSX.SVGAttributes<SVGSVGElement>;
const base = (children: JSX.Element | JSX.Element[], p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" {...p}>
    {children}
  </svg>
);

export const IconScan = (p: P) =>
  base(
    [
      <path key="a" d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />,
      <rect key="b" x="8.5" y="7" width="7" height="10" rx="1.5" />,
    ],
    p,
  );
export const IconStack = (p: P) =>
  base([<rect key="a" x="7" y="3" width="11" height="15" rx="2" />, <path key="b" d="M4 7v11a3 3 0 0 0 3 3h8" />], p);
export const IconBook = (p: P) =>
  base([<path key="a" d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z" />, <path key="b" d="M4 20a2 2 0 0 0 2 1h13v-3" />, <path key="c" d="m9 9 2 2 4-4" />], p);
export const IconSearch = (p: P) => base([<circle key="a" cx="11" cy="11" r="7" />, <path key="b" d="m20 20-3.5-3.5" />], p);
export const IconGear = (p: P) =>
  base(
    [
      <circle key="a" cx="12" cy="12" r="3" />,
      <path
        key="b"
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
      />,
    ],
    p,
  );
export const IconBolt = (p: P) => base(<path d="M13 2 4 14h7l-1 8 9-12h-7z" />, p);
export const IconPause = (p: P) => base([<rect key="a" x="6" y="5" width="4" height="14" rx="1" />, <rect key="b" x="14" y="5" width="4" height="14" rx="1" />], p);
export const IconPlay = (p: P) => base(<path d="M7 4v16l13-8z" />, p);
export const IconUndo = (p: P) => base([<path key="a" d="M9 14 4 9l5-5" />, <path key="b" d="M4 9h11a5 5 0 0 1 0 10h-3" />], p);
export const IconCamOff = (p: P) =>
  base([<path key="a" d="m2 2 20 20" />, <path key="b" d="M7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h13M10 4h4l2 3h4a2 2 0 0 1 2 2v8" />], p);
export const IconWifiOff = (p: P) =>
  base([<path key="a" d="m2 2 20 20" />, <path key="b" d="M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.2-1.7M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 11 5" />, <path key="c" d="M12 20h.01" />], p);
export const IconDownload = (p: P) => base([<path key="a" d="M12 3v12" />, <path key="b" d="m7 10 5 5 5-5" />, <path key="c" d="M5 21h14" />], p);
export const IconPlus = (p: P) => base(<path d="M12 5v14M5 12h14" />, p);
export const IconTrash = (p: P) => base([<path key="a" d="M4 7h16M10 11v6M14 11v6" />, <path key="b" d="M6 7l1 13h10l1-13M9 7V4h6v3" />], p);
export const IconX = (p: P) => base(<path d="M6 6l12 12M18 6 6 18" />, p);
export const IconCheck = (p: P) => base(<path d="m5 12 5 5 9-10" />, p);
export const IconExternal = (p: P) => base([<path key="a" d="M14 4h6v6" />, <path key="b" d="M20 4 10 14" />, <path key="c" d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />], p);
export const IconChevron = (p: P) => base(<path d="m9 6 6 6-6 6" />, p);
export const IconSound = (p: P) => base([<path key="a" d="M4 9v6h4l5 4V5L8 9z" />, <path key="b" d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" />], p);
