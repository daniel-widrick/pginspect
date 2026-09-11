<script lang="ts">
  import { onMount } from 'svelte'
  import {
    EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection,
    highlightSpecialChars, rectangularSelection, highlightActiveLineGutter, placeholder,
  } from '@codemirror/view'
  import { EditorState, Compartment, Prec } from '@codemirror/state'
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
  import { sql, PostgreSQL } from '@codemirror/lang-sql'
  import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
  import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
  import { tags as t } from '@lezer/highlight'

  interface Props {
    value: string
    schema?: Record<string, Record<string, string[]>>
    onRun?: (sql: string) => void
  }
  let { value = $bindable(''), schema = {}, onRun }: Props = $props()

  let host: HTMLDivElement
  let view: EditorView | undefined
  const langComp = new Compartment()

  const theme = EditorView.theme({
    '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--fg)', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
    '.cm-content': { caretColor: 'var(--fg)', padding: '6px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '&.cm-focused .cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--fg) 4%, transparent)' },
    '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--fg-3)', border: 'none', paddingLeft: '4px' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-2)' },
    '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)', outline: 'none' },
    '.cm-tooltip': { backgroundColor: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--fg)' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' },
    '.cm-placeholder': { color: 'var(--fg-3)', fontStyle: 'italic' },
  })

  const highlight = HighlightStyle.define([
    { tag: t.keyword, color: 'var(--syn-keyword)' },
    { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
    { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
    { tag: [t.typeName, t.className], color: 'var(--syn-type)' },
    { tag: [t.operator, t.punctuation], color: 'var(--syn-operator)' },
    { tag: [t.function(t.variableName), t.standard(t.name)], color: 'var(--syn-func)' },
  ])

  function langExt(s: Props['schema']) {
    return sql({ dialect: PostgreSQL, schema: s as any, defaultSchema: 'public', upperCaseKeywords: false })
  }

  /** Text to execute: the selection if there is one, otherwise the whole document. */
  export function getRunnableSql(): string {
    if (!view) return value
    const sel = view.state.selection.main
    return sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to)
  }

  export function focus(): void {
    view?.focus()
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(keymap.of([
            { key: 'Mod-Enter', run: () => { onRun?.(getRunnableSql()); return true } },
          ])),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          highlightActiveLine(),
          placeholder('Write SQL here. Cmd/Ctrl+Enter runs the selection or the whole editor.'),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          langComp.of(langExt(schema)),
          theme,
          syntaxHighlighting(highlight),
          EditorView.updateListener.of(u => {
            if (u.docChanged) value = u.state.doc.toString()
          }),
        ],
      }),
    })
    view.focus()
    return () => { view?.destroy(); view = undefined }
  })

  // Push external edits (for example a tab opened with a prefilled query) into the editor.
  $effect(() => {
    const next = value
    if (view && next !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    }
  })

  $effect(() => {
    const s = schema
    view?.dispatch({ effects: langComp.reconfigure(langExt(s)) })
  })
</script>

<div class="editor" bind:this={host}></div>

<style>
  .editor { height: 100%; overflow: hidden; }
  .editor :global(.cm-editor) { height: 100%; }
  .editor :global(.cm-editor.cm-focused) { outline: none; }
</style>
