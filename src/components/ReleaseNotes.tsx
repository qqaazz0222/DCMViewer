import { useState } from "react";
import { X } from "lucide-react";
import history from "../../HISTORY.md?raw";

const SEEN_KEY = "dcmviewer.releaseNotesSeen";

// "## v2.3.0 (date)" section of HISTORY.md as bullet lines.
function notesFor(version: string) {
    const section = history.split(/^## /m).find(part => part.startsWith(`v${version} `) || part.startsWith(`v${version}\n`));
    if (!section) return undefined;
    const [heading, ...lines] = section.split("\n");
    return { heading, items: lines.filter(line => line.startsWith("- ")).map(line => line.slice(2)) };
}

// **bold** and `code` only; that is all HISTORY.md uses inline.
function inline(text: string) {
    return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, index) =>
        part.startsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong>
        : part.startsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part);
}

// Desktop only: shown on the first launch after installing or updating to a new version.
export function ReleaseNotes({ version }: { version: string }) {
    const notes = notesFor(version);
    const [open, setOpen] = useState(() => {
        try { return Boolean(notes) && localStorage.getItem(SEEN_KEY) !== version; }
        catch { return false; }
    });
    if (!open || !notes) return null;
    const close = () => {
        setOpen(false);
        try { localStorage.setItem(SEEN_KEY, version); } catch { /* shown again next launch */ }
    };
    return (
        <div className="metadataOverlay" onClick={close}>
            <section className="helpModal releaseNotes" role="dialog" aria-modal="true" aria-label="Release notes" onClick={event => event.stopPropagation()}>
                <header><strong>What's new in {notes.heading}</strong>
                    <button autoFocus type="button" aria-label="Close dialog" onClick={close}><X size={16} /></button></header>
                <ul>{notes.items.map((item, index) => <li key={index}>{inline(item)}</li>)}</ul>
            </section>
        </div>
    );
}
