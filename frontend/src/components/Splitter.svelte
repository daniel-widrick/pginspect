<script lang="ts">
  // A drag handle. Reports pointer movement along its axis; the parent owns the size.
  interface Props { direction: 'horizontal' | 'vertical'; onDrag: (delta: number) => void }
  let { direction, onDrag }: Props = $props()

  let last = 0
  function down(e: PointerEvent) {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    last = direction === 'horizontal' ? e.clientX : e.clientY
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }
  function move(e: PointerEvent) {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const now = direction === 'horizontal' ? e.clientX : e.clientY
    onDrag(now - last)
    last = now
  }
  function up() {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
</script>

<div class="splitter {direction}" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} role="separator" aria-orientation={direction}></div>

<style>
  .splitter { flex-shrink: 0; background: var(--border); position: relative; z-index: 3; }
  .splitter::after { content: ''; position: absolute; inset: -3px; }
  .horizontal { width: 1px; cursor: col-resize; }
  .vertical { height: 1px; cursor: row-resize; }
  .splitter:hover, .splitter:active { background: var(--accent); }
</style>
