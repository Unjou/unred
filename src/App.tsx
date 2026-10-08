import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  Activity, AlertCircle, AlertTriangle, ArrowDownToLine, Check,
  CheckCheck, ChevronDown, CircleHelp, Code2, FileCode2, FilePlus2, Files,
  FolderOpen, Languages, Menu, MessageSquareText, PanelRight, Search,
  ShieldCheck, Trash2, Upload, X,
} from 'lucide-react';
import { analyzeLine, createDemoDocument, createUnifiedPatch, decodeKagBytes, encodeKagText, parseKagScript, stringifyKagScript, wrapLatinText, type ScriptDocument, type ScriptEncoding, type ScriptLine } from '@/lib/kag';
import { deleteDocument, loadDocuments, saveDocument } from '@/lib/persistence';

type FilterMode = 'all' | 'untranslated' | 'issues';
type SaveState = 'loading' | 'saved' | 'saving' | 'error';

const statusText = {
  untranslated: 'Needs translation',
  ready: 'Ready',
  warning: 'Review',
  error: 'Error',
} as const;

function App() {
  const [documents, setDocuments] = useState<ScriptDocument[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState('');
  const [activeLineId, setActiveLineId] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [toast, setToast] = useState('');
  const [leftDrawer, setLeftDrawer] = useState(false);
  const [rightDrawer, setRightDrawer] = useState(false);
  const [loading, setLoading] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeDocument = documents.find((document) => document.id === activeDocumentId) ?? null;
  const selectedLine = activeDocument?.lines.find((line) => line.id === activeLineId) ?? null;
  const activeLine = selectedLine?.kind === 'dialogue'
    ? selectedLine
    : activeDocument?.lines.find((line) => line.kind === 'dialogue') ?? null;

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2600);
  }, []);

  useEffect(() => {
    let mounted = true;
    const initialize = async () => {
      try {
        let found = await loadDocuments();
        if (!found.length) {
          const demo = createDemoDocument();
          await saveDocument(demo);
          found = [demo];
        }
        if (mounted) {
          setDocuments(found);
          setActiveDocumentId(found[0]?.id ?? '');
          setActiveLineId(found[0]?.lines.find((line) => line.kind === 'dialogue')?.id ?? '');
          setSaveState('saved');
        }
      } catch {
        if (mounted) {
          const demo = createDemoDocument();
          setDocuments([demo]);
          setActiveDocumentId(demo.id);
          setActiveLineId(demo.lines.find((line) => line.kind === 'dialogue')?.id ?? '');
          setSaveState('error');
          notify('Local storage could not be read. Demo script is available for this session.');
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void initialize();
    return () => { mounted = false; };
  }, [notify]);

  useEffect(() => {
    if (!activeDocument || loading) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('saving');
    saveTimer.current = setTimeout(() => {
      void saveDocument(activeDocument).then(() => {
        setSaveState('saved');
      }).catch(() => {
        setSaveState('error');
      });
    }, 380);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [activeDocument, loading]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const dialogueLines = useMemo(
    () => activeDocument?.lines.filter((line) => line.kind === 'dialogue') ?? [],
    [activeDocument],
  );
  const evaluatedLines = useMemo(
    () => dialogueLines.map((line) => ({ line, result: analyzeLine(line, 42) })),
    [dialogueLines],
  );
  const readyCount = evaluatedLines.filter(({ result }) => result.status === 'ready').length;
  const unresolvedCount = evaluatedLines.filter(({ result }) => result.status !== 'ready').length;
  const completion = dialogueLines.length ? Math.round((readyCount / dialogueLines.length) * 100) : 0;
  const issueCount = evaluatedLines.reduce((total, item) => total + item.result.issues.length, 0);

  const visibleLines = useMemo(() => {
    if (!activeDocument) return [];
    const normalized = query.trim().toLocaleLowerCase();
    return activeDocument.lines.filter((line) => {
      if (line.kind === 'blank') return filter === 'all' && !normalized;
      const result = line.kind === 'dialogue' ? analyzeLine(line, 42) : null;
      const matchesFilter =
        filter === 'all' ||
        (filter === 'untranslated' && result?.status === 'untranslated') ||
        (filter === 'issues' && result && (result.status === 'warning' || result.status === 'error'));
      const matchesSearch = !normalized || [line.source, line.target ?? '', line.speaker ?? '', line.original]
        .some((value) => value.toLocaleLowerCase().includes(normalized));
      return matchesFilter && matchesSearch;
    });
  }, [activeDocument, filter, query]);

  const updateTarget = (lineId: string, value: string) => {
    if (!activeDocument) return;
    const updated: ScriptDocument = {
      ...activeDocument,
      updatedAt: Date.now(),
      lines: activeDocument.lines.map((line) => line.id === lineId ? { ...line, target: value } : line),
    };
    setDocuments((previous) => previous.map((document) => document.id === updated.id ? updated : document));
  };

  const updateEncoding = (encoding: ScriptEncoding) => {
    if (!activeDocument) return;
    const updated = { ...activeDocument, encoding, updatedAt: Date.now() };
    setDocuments((previous) => previous.map((document) => document.id === updated.id ? updated : document));
  };

  const chooseDocument = (id: string) => {
    const document = documents.find((item) => item.id === id);
    if (!document) return;
    setActiveDocumentId(id);
    setActiveLineId(document.lines.find((line) => line.kind === 'dialogue')?.id ?? document.lines[0]?.id ?? '');
    setLeftDrawer(false);
    setFilter('all');
  };

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const accepted = Array.from(files).filter((file) => /\.(ks|txt)$/i.test(file.name));
    if (!accepted.length) {
      notify('Choose a .ks or .txt script file.');
      return;
    }
    try {
      const imported = await Promise.all(accepted.map(async (file) => {
        const decoded = decodeKagBytes(await file.arrayBuffer());
        const document = parseKagScript(decoded.text, file.name);
        return { ...document, encoding: decoded.encoding, hasBom: decoded.hasBom };
      }));
      for (const document of imported) await saveDocument(document);
      setDocuments((previous) => [...imported, ...previous]);
      setActiveDocumentId(imported[0].id);
      setActiveLineId(imported[0].lines.find((line) => line.kind === 'dialogue')?.id ?? '');
      setLeftDrawer(false);
      notify(`${imported.length} script${imported.length === 1 ? '' : 's'} imported locally.`);
    } catch {
      notify('The script could not be imported. The current work remains unchanged.');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeDocument = async (event: MouseEvent, document: ScriptDocument) => {
    event.stopPropagation();
    if (documents.length < 2) {
      notify('Keep at least one script in the workspace.');
      return;
    }
    if (!window.confirm(`Remove ${document.fileName} from this browser?`)) return;
    try {
      await deleteDocument(document.id);
      const remaining = documents.filter((item) => item.id !== document.id);
      setDocuments(remaining);
      if (activeDocumentId === document.id) {
        setActiveDocumentId(remaining[0]?.id ?? '');
        setActiveLineId(remaining[0]?.lines.find((line) => line.kind === 'dialogue')?.id ?? '');
      }
      notify(`${document.fileName} removed from local workspace.`);
    } catch {
      notify('Could not remove this script from local storage.');
    }
  };

  const download = (filename: string, content: string | Blob, type = 'text/plain;charset=utf-8') => {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportScript = () => {
    if (!activeDocument) return;
    try {
      const reconstructed = stringifyKagScript(activeDocument);
      download(activeDocument.fileName, encodeKagText(reconstructed, activeDocument.encoding, activeDocument.hasBom));
      notify(`Reconstructed ${activeDocument.encoding} script downloaded.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The script could not be encoded for export.');
    }
  };

  const exportPatch = () => {
    if (!activeDocument) return;
    const changed = activeDocument.lines.filter((line) =>
      line.kind === 'dialogue' && line.target?.trim() && line.target !== line.source,
    );
    if (!changed.length) {
      notify('Add at least one translation before exporting a patch.');
      return;
    }
    const lineEnding = activeDocument.lineEnding ?? '\n';
    const original = activeDocument.lines.map((line) => line.original).join(lineEnding)
      + (activeDocument.trailingNewline ? lineEnding : '');
    const translated = stringifyKagScript(activeDocument);
    const patch = createUnifiedPatch(original, translated, activeDocument.fileName);
    download(`${activeDocument.fileName}.unred.patch.txt`, patch);
    notify('Local translation patch downloaded.');
  };

  const autoWrap = () => {
    if (!activeLine?.target?.trim()) {
      notify('Enter a translation before applying line wrapping.');
      return;
    }
    const wrapped = wrapLatinText(activeLine.target, 42, 3);
    if (wrapped === activeLine.target) {
      notify('This translation already fits the current wrap guideline.');
      return;
    }
    updateTarget(activeLine.id, wrapped);
    notify('KAG line breaks added to the active translation.');
  };

  const selectLine = (line: ScriptLine) => {
    setActiveLineId(line.id);
    setRightDrawer(false);
  };

  const stepSegment = (direction: -1 | 1) => {
    if (!dialogueLines.length) return;
    const currentIndex = dialogueLines.findIndex((line) => line.id === activeLineId);
    const next = dialogueLines[Math.max(0, Math.min(dialogueLines.length - 1, currentIndex + direction))];
    if (next) {
      setActiveLineId(next.id);
      document.querySelector(`[data-line-id="${CSS.escape(next.id)}"] textarea`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };

  const filesPanel = (
    <div className="file-panel-content">
      <div className="rail-head">
        <div className="rail-title">Project files</div>
        <div className="rail-buttons">
          <button className="tiny-button" aria-label="Import script" data-testid="button-import-script" onClick={() => fileInputRef.current?.click()}><FilePlus2 size={14} /></button>
          <button className="tiny-button" aria-label="Close file drawer" data-testid="button-close-files" onClick={() => setLeftDrawer(false)}><X size={14} /></button>
        </div>
      </div>
      <div className="eyebrow" style={{ padding: '0 14px 7px' }}>LOCAL WORKSPACE · {documents.length} FILE{documents.length === 1 ? '' : 'S'}</div>
      <div className="file-list" data-testid="list-project-files">
        {documents.map((document) => (
          <button key={document.id} className={`file-row ${document.id === activeDocumentId ? 'selected' : ''}`}
            data-testid={`file-item-${document.id}`} onClick={() => chooseDocument(document.id)}>
            <FileCode2 size={14} color={document.id === activeDocumentId ? 'var(--indigo)' : 'var(--quiet)'} />
            <span className="file-row-name">{document.fileName}</span>
            <span className="file-count">{document.lines.filter((line) => line.kind === 'dialogue').length}</span>
            {documents.length > 1 && <span className="file-delete" role="button" aria-label={`Remove ${document.fileName}`} data-testid={`button-remove-file-${document.id}`} onClick={(event) => void removeDocument(event, document)}><Trash2 size={12} /></span>}
          </button>
        ))}
        {!documents.length && <p className="rail-hint">No scripts yet. Import a KAG file to begin.</p>}
      </div>
      <div className="rail-section">
        <div className="rail-section-title"><ShieldCheck size={14} color="var(--green)" /> Translation status</div>
        <div className="qa-overview">
          <div className="qa-overview-top"><span className="qa-count">Segments ready</span><span className="qa-number">{readyCount}/{dialogueLines.length}</span></div>
          <div className="progress-track"><div className="progress-fill" style={{ width: `${completion}%` }} /></div>
          <div className="progress-copy"><span>{completion}% complete</span><span>{unresolvedCount} remaining</span></div>
        </div>
        <p className="rail-hint">Scripts stay in this browser. Nothing is sent to a server.</p>
      </div>
      <div className="rail-bottom"><ShieldCheck size={13} color="var(--green)" /> Private by default <span style={{ marginLeft: 'auto' }}>LOCAL</span></div>
    </div>
  );

  const inspectorPanel = (
    <div className="inspector-content">
      <div className="inspector-head">
        <div className="inspector-title"><PanelRight size={14} color="var(--indigo)" /> Inspector</div>
        <button className="tiny-button" aria-label="Close inspector" data-testid="button-close-inspector" onClick={() => setRightDrawer(false)}><X size={14} /></button>
      </div>
      <section className="inspector-section">
        <div className="section-heading"><span><Activity size={13} style={{ verticalAlign: '-2px', marginRight: 6, color: 'var(--cyan)' }} />Script overview</span><small>{activeDocument?.engine ?? 'KAG'}</small></div>
        <div className="stat-row"><span>Dialogue segments</span><span className="stat-value">{dialogueLines.length}</span></div>
        <div className="stat-row"><span>Translated</span><span className="stat-value" style={{ color: 'var(--green)' }}>{readyCount} / {dialogueLines.length}</span></div>
        <div className="stat-row"><span>QA findings</span><span className="stat-value" style={{ color: issueCount ? 'var(--amber)' : 'var(--green)' }}>{issueCount}</span></div>
        <div className="progress-track" style={{ marginTop: 12 }}><div className="progress-fill" style={{ width: `${completion}%` }} /></div>
        <div className="progress-copy"><span>Translation coverage</span><span>{completion}%</span></div>
      </section>
      <section className="inspector-section">
        <div className="section-heading"><span><AlertTriangle size={13} style={{ verticalAlign: '-2px', marginRight: 6, color: 'var(--amber)' }} />QA findings</span><small>{issueCount} TOTAL</small></div>
        {evaluatedLines.filter(({ result }) => result.issues.length > 0).slice(0, 6).map(({ line, result }) => (
          <button key={line.id} className="qa-issue" data-testid={`qa-issue-${line.id}`} onClick={() => selectLine(line)}>
            <span className={`issue-marker ${result.status === 'error' ? 'error' : ''}`} />
            <span><span className="mono" style={{ color: 'var(--quiet)' }}>Line {line.lineNumber}: </span>{result.issues[0]}</span>
          </button>
        ))}
        {!issueCount && <div className="empty-issue" data-testid="status-qa-clean"><Check size={13} style={{ verticalAlign: '-3px', marginRight: 6 }} />No issues found in this script</div>}
        {issueCount > 6 && <div className="rail-hint">Showing 6 findings. Filter “Issues” to inspect all flagged segments.</div>}
      </section>
      <section className="inspector-section">
        <div className="section-heading"><span><MessageSquareText size={13} style={{ verticalAlign: '-2px', marginRight: 6, color: 'var(--violet)' }} />Dialogue preview</span><button className="tiny-button" aria-label="Previous segment" data-testid="button-previous-segment" onClick={() => stepSegment(-1)}><ChevronDown size={14} style={{ transform: 'rotate(90deg)' }} /></button></div>
        <div className="preview-box" data-testid="dialogue-preview">
          <div className="preview-speaker">{activeLine?.speaker || 'Narration'} <span className="eyebrow" style={{ float: 'right' }}>ID · PREVIEW</span></div>
          <div className="preview-text">{activeLine?.target?.trim() || activeLine?.source || 'Select a dialogue segment to preview it here.'}</div>
          <div className="preview-meta">KAG dialogue · {activeLine ? `line ${activeLine.lineNumber}` : '—'}</div>
        </div>
        <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
          <button className="filter-chip" style={{ flex: 1 }} data-testid="button-preview-previous" onClick={() => stepSegment(-1)}><ChevronDown size={12} style={{ transform: 'rotate(90deg)' }} /> Previous</button>
          <button className="filter-chip" style={{ flex: 1 }} data-testid="button-preview-next" onClick={() => stepSegment(1)}>Next <ChevronDown size={12} style={{ transform: 'rotate(-90deg)' }} /></button>
        </div>
      </section>
      <section className="inspector-section">
        <div className="section-heading"><span><Code2 size={13} style={{ verticalAlign: '-2px', marginRight: 6, color: 'var(--cyan)' }} />Engine details</span></div>
        <div className="stat-row"><span>Profile</span><span className="stat-value">{activeDocument?.engine ?? '—'}</span></div>
        <div className="stat-row"><span>Encoding</span><span className="stat-value">{activeDocument?.encoding ?? '—'}</span></div>
        <div className="stat-row"><span>Wrap guideline</span><span className="stat-value">42 characters</span></div>
        <p className="rail-hint">KAG tags and control syntax are preserved in the reconstructed export.</p>
      </section>
    </div>
  );

  return (
    <main className="workbench" data-testid="unred-workbench">
      <header className="topbar">
        <div className="brand-mark"><Languages size={15} /></div>
        <div><div className="brand-title">unred</div><div className="brand-caption">KAG localization workbench</div></div>
        <div className="project-tag"><span className="eyebrow">WORKING PROJECT</span><span style={{ color: '#c8ceda', fontSize: 11 }}>{activeDocument?.fileName ?? 'No script selected'}</span></div>
        <div className="topbar-spacer" />
        <div className="topbar-status"><span className="status-dot" /> Browser-only workspace</div>
        <button className="top-action" aria-label="Import script" data-testid="button-import-top" onClick={() => fileInputRef.current?.click()}><Upload size={13} /><span className="wide-label">Import script</span></button>
        <button className="top-action" aria-label="Export translation patch" data-testid="button-export-patch" onClick={exportPatch} disabled={!activeDocument}><ArrowDownToLine size={13} /><span className="wide-label">Export patch</span></button>
        <button className="top-action primary" aria-label="Export reconstructed script" data-testid="button-export-script" onClick={exportScript} disabled={!activeDocument}><ArrowDownToLine size={13} /><span className="wide-label">Export script</span></button>
        <input ref={fileInputRef} type="file" accept=".ks,.txt,text/plain" multiple hidden data-testid="input-import-script" onChange={(event) => void importFiles(event.currentTarget.files)} />
      </header>
      <div className="main-layout">
        <aside className="file-rail">{filesPanel}</aside>
        <section className="editor-shell">
          <div className="editor-toolbar">
            <div className="mobile-context">
              <button className="side-trigger" data-testid="button-open-files" onClick={() => setLeftDrawer(true)}><Menu size={14} /> Files</button>
            </div>
            <div className="active-file"><FileCode2 size={15} color="var(--indigo)" /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{activeDocument?.fileName ?? 'Select a script'}</span></div>
            {activeDocument && <><span className="engine-pill">{activeDocument.engine}</span><select className="encoding-pill" aria-label="Export encoding" data-testid="select-export-encoding" value={activeDocument.encoding} onChange={(event) => updateEncoding(event.currentTarget.value as ScriptEncoding)}><option value="UTF-8">UTF-8</option><option value="Shift-JIS">Shift-JIS</option></select></>}
            <div className="toolbar-divider" />
            <label className="search-wrap"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find text or speaker..." aria-label="Search segments" data-testid="input-search-segments" /><span className="eyebrow">/</span></label>
            <div className="toolbar-spacer" />
            <button className={`filter-chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')} data-testid="filter-all"><Files size={12} /> All</button>
            <button className={`filter-chip ${filter === 'untranslated' ? 'active' : ''}`} onClick={() => setFilter('untranslated')} data-testid="filter-untranslated"><Languages size={12} /> Needs work</button>
            <button className={`filter-chip ${filter === 'issues' ? 'active' : ''}`} onClick={() => setFilter('issues')} data-testid="filter-issues"><AlertCircle size={12} /> Issues</button>
            <button className="filter-chip" onClick={autoWrap} disabled={!activeLine?.target?.trim()} data-testid="button-auto-wrap"><Code2 size={12} /> Auto wrap</button>
            <div className="mobile-context">
              <button className="side-trigger" data-testid="button-open-inspector" onClick={() => setRightDrawer(true)}><PanelRight size={14} /> Inspect</button>
            </div>
          </div>
          <div className="segments-scroll" data-testid="list-segments">
            <div className="column-header"><div>Ln</div><div>Source · Japanese</div><div>Target · Indonesian</div><div>Segment</div></div>
            {loading ? (
              <div style={{ padding: '20px 14px', display: 'grid', gap: 10 }} data-testid="status-loading">
                {[0, 1, 2, 3, 4].map((item) => <div key={item} className="loading-line" style={{ width: `${92 - item * 7}%`, height: 62 }} />)}
              </div>
            ) : !activeDocument ? (
              <div className="empty-state" data-testid="status-empty"><FolderOpen size={26} /><strong>No script open</strong><span>Import a .ks or .txt script to start localizing.</span><button className="top-action primary" onClick={() => fileInputRef.current?.click()}><Upload size={13} /> Import a script</button></div>
            ) : visibleLines.length === 0 ? (
              <div className="empty-state" data-testid="status-no-matches"><Search size={24} /><strong>No matching segments</strong><span>Try another search or switch to a different filter.</span><button className="filter-chip" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</button></div>
            ) : visibleLines.map((line) => {
              if (line.kind === 'blank') return <div key={line.id} className="segment-row blank-row" data-testid={`segment-row-${line.id}`}><div className="line-number">{line.lineNumber}</div><div className="source-cell" /><div className="target-cell" /><div className="status-cell" /></div>;
              const result = line.kind === 'dialogue' ? analyzeLine(line, 42) : null;
              const isSelected = activeLineId === line.id;
              return (
                <div key={line.id} className={`segment-row ${line.kind !== 'dialogue' ? 'kind-row' : ''} ${isSelected ? 'selected' : ''}`}
                  data-line-id={line.id} data-testid={`segment-row-${line.id}`} onClick={() => selectLine(line)}>
                  <div className="line-number">{line.lineNumber}</div>
                  <div className="source-cell">
                    {line.kind !== 'dialogue' && <span className="kind-label">{line.kind}</span>}
                    {line.kind === 'comment' ? line.original : line.source}
                  </div>
                  <div className="target-cell">
                    {line.kind === 'dialogue' ? <>
                      <textarea value={line.target ?? ''} onFocus={() => setActiveLineId(line.id)}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => updateTarget(line.id, event.currentTarget.value)}
                        placeholder="Tulis terjemahan dalam Bahasa Indonesia..."
                        aria-label={`Indonesian translation for line ${line.lineNumber}`}
                        data-testid={`input-target-${line.id}`} />
                      <div className="target-footer"><span>{line.speaker ?? 'Narration'}</span><span className={`char-meter ${result && result.charCount > 42 ? 'warning' : ''}`} data-testid={`text-char-count-${line.id}`}>{result?.charCount ?? 0} / 42</span></div>
                    </> : <><span className="kind-label">Preserved engine syntax</span>{line.original}</>}
                  </div>
                  <div className="status-cell">
                    {line.kind === 'dialogue' && result && <>
                      <span className={`status-label ${result.status}`} data-testid={`status-line-${line.id}`}>
                        {result.status === 'ready' ? <CheckCheck size={12} /> : result.status === 'error' ? <AlertCircle size={12} /> : result.status === 'warning' ? <AlertTriangle size={12} /> : <CircleHelp size={12} />}
                        {statusText[result.status]}
                      </span>
                      {line.speaker && <span className="speaker-label">{line.speaker}</span>}
                    </>}
                  </div>
                </div>
              );
            })}
          </div>
          <footer className="bottom-bar">
            <span className="bottom-group"><FileCode2 size={11} /> {activeDocument?.engine ?? 'KAG'} · Script</span>
            <span className="bottom-group optional"><Languages size={11} /> JA → ID</span>
            <span className="bottom-group optional">{activeDocument?.encoding ?? 'UTF-8'}</span>
            <span className="bottom-spacer" />
            <span className={`bottom-group save-state ${saveState === 'error' ? 'error' : ''}`} data-testid="status-save">
              {saveState === 'saving' ? <><Activity size={11} /> Saving locally…</> : saveState === 'error' ? <><AlertCircle size={11} /> Save issue</> : <><Check size={11} /> Saved locally</>}
            </span>
            <span className="bottom-group optional">{activeDocument?.lines.length ?? 0} lines</span>
          </footer>
        </section>
        <aside className="inspector">{inspectorPanel}</aside>
      </div>
      {(leftDrawer || rightDrawer) && <div className="drawer-shade" onClick={() => { setLeftDrawer(false); setRightDrawer(false); }} data-testid="drawer-backdrop" />}
      {leftDrawer && <aside className="mobile-drawer" data-testid="drawer-files">{filesPanel}</aside>}
      {rightDrawer && <aside className="mobile-drawer right" data-testid="drawer-inspector">{inspectorPanel}</aside>}
      {toast && <div className="toast-note" role="status" data-testid="status-toast">{toast}</div>}
    </main>
  );
}

export default App;
