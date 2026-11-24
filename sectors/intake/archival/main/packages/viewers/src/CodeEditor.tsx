import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap, autocompletion } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { go } from "@codemirror/lang-go";
import { yaml } from "@codemirror/lang-yaml";

export function languageFor(ext: string) {
  switch (ext) {
    case "js": case "mjs": case "cjs": return javascript();
    case "jsx": return javascript({ jsx: true });
    case "ts": case "mts": return javascript({ typescript: true });
    case "tsx": return javascript({ typescript: true, jsx: true });
    case "py": return python();
    case "rs": return rust();
    case "md": case "markdown": case "mdx": return markdown();
    case "html": case "htm": case "svg": case "xml": case "vue": case "svelte": return html();
    case "css": case "scss": return css();
    case "json": return json();
    case "go": return go();
    case "yaml": case "yml": return yaml();
    default: return [];
  }
}

// greys and the silver accent carry the syntax; colour stays rare
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "var(--text)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--add)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--warn)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--accent)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--accent)", fontStyle: "italic" },
  { tag: [t.propertyName, t.attributeName], color: "color-mix(in srgb, var(--text) 82%, var(--muted))" },
  { tag: [t.heading], color: "var(--text)", fontWeight: "700" },
  { tag: [t.link, t.url], color: "var(--accent)", textDecoration: "underline" },
  { tag: [t.tagName], color: "var(--accent)" },
  { tag: [t.invalid], color: "var(--del)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--font-body)", fontVariationSettings: '"MONO" 1, "CASL" 0', lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--text)", padding: "12px 0 120px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "color-mix(in srgb, var(--muted) 70%, transparent)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--text) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent) !important" },
  ".cm-cursor": { borderLeftColor: "var(--text)", borderLeftWidth: "2px" },
  ".cm-matchingBracket": { outline: "1px solid var(--edge)", backgroundColor: "transparent" },
  ".cm-panels": { backgroundColor: "var(--glass)", color: "var(--text)", borderTop: "1px solid var(--line)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 25%, transparent)" },
  ".cm-tooltip": { backgroundColor: "var(--glass)", border: "1px solid var(--line)", borderRadius: "8px" },
  "&.cm-focused": { outline: "none" },
});

export function CodeEditor({ value, ext, onChange, onSave, readOnly = false, label = "editor" }: { value: string; ext: string; onChange?: (v: string) => void; onSave?: () => void; readOnly?: boolean; label?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const ro = useRef(new Compartment());
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(),
          indentOnInput(), bracketMatching(), closeBrackets(), autocompletion(), highlightActiveLine(), highlightSelectionMatches(),
          syntaxHighlighting(highlight), theme, EditorView.lineWrapping,
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { cb.current.onSave?.(); return true; } }, indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap]),
          lang.current.of(languageFor(ext)),
          ro.current.of(EditorState.readOnly.of(readOnly)),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange?.(u.state.doc.toString()); }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => { view.current?.dispatch({ effects: lang.current.reconfigure(languageFor(ext)) }); }, [ext]);
  useEffect(() => { view.current?.dispatch({ effects: ro.current.reconfigure(EditorState.readOnly.of(readOnly)) }); }, [readOnly]);

  return <div className="code-editor" ref={host} />;
}
