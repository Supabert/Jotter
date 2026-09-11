<script lang="ts">
  import { store } from '../store.svelte';
</script>

{#if store.toast}
  <div class="toast plate" role="status">
    <span class="anc anc-{store.toast.tone} legend">{store.toast.text}</span>
    <!-- Offered rather than demanded: a drag that overwrote two dates is easy
         to fumble and should be cheap to take back, but a confirmation before
         every drag would make the common case pay for the rare one. -->
    {#if store.toast.undo}
      <button class="undo legend" onclick={() => store.toast?.undo?.()}>Undo</button>
    {/if}
  </div>
{/if}

<style>
  /* Rises from the status strip, which is where machine state is reported —
     it does not float in from a corner like a notification. */
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(var(--strip) + 10px);
    transform: translateX(-50%);
    padding: 6px 12px;
    background: var(--panel-3);
    z-index: 60;
    animation: rise var(--dur-base) var(--ease);
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .toast .legend {
    font-size: 10.5px;
    color: var(--lamp);
  }

  .undo {
    padding: 1px 6px;
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    background: var(--panel-2);
    color: var(--ink-soft);
    cursor: pointer;
    transition: border-color var(--dur-fast) var(--ease);
  }

  .undo:hover {
    border-color: var(--legend);
    color: var(--ink);
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translate(-50%, 5px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
