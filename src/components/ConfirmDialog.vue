<script setup lang="ts">
import { nextTick, onBeforeUnmount, watch } from 'vue'
import { useAppStore } from '../stores/app'
const app = useAppStore()
function key(event: KeyboardEvent) {
  if (!app.confirmation) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); app.respond(false) }
  if (event.key === 'Tab') {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-confirm-dialog] button')]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    event.preventDefault()
    buttons[(current + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus()
  }
}
watch(() => app.confirmation, async value => {
  if (value) { document.addEventListener('keydown', key, true); await nextTick(); document.querySelector<HTMLButtonElement>('[data-confirm-cancel]')?.focus() }
  else document.removeEventListener('keydown', key, true)
})
onBeforeUnmount(() => document.removeEventListener('keydown', key, true))
</script>
<template>
  <div v-if="app.confirmation" class="dialog-backdrop">
    <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" data-confirm-dialog>
      <h2 id="confirm-title">{{ app.confirmation.title }}</h2><p>{{ app.confirmation.message }}</p>
      <div class="dialog-actions"><button class="btn btn-secondary" data-confirm-cancel @click="app.respond(false)">取消</button><button class="btn" :class="app.confirmation.danger ? 'btn-danger' : 'btn-primary'" @click="app.respond(true)">{{ app.confirmation.label }}</button></div>
    </section>
  </div>
</template>
