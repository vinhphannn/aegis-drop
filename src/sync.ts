import { DirectPeer } from './peer';
import { HistoryStore } from './history';
import type { HistoryItem, InventoryItem } from './history';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class HistorySync {
  private peers = new Map<DirectPeer, SyncPeer>();
  readonly reservations = new Map<string, SyncPeer>();
  private off: () => void;
  private wasBusy = false;
  private failedCycle = false;
  private disposed = false;
  constructor(readonly history: HistoryStore, private readonly feedback: (message: string) => void, private readonly errorFeedback: (message: string) => void) {
    this.off = history.onAdded(item => {
      const owner = this.reservations.get(item.id);
      this.reservations.delete(item.id); owner?.received(item.id);
      for (const peer of this.peers.values()) peer.announce(item);
    });
  }
  error = (message: string) => {
    this.failedCycle = true; this.feedback(''); this.errorFeedback(message);
  };
  status() {
    if (this.disposed) return;
    const busy = this.reservations.size > 0 || [...this.peers.values()].some(peer => peer.busy);
    if (busy === this.wasBusy) return;
    this.wasBusy = busy;
    if (busy) { this.failedCycle = false; this.feedback('Syncing…'); }
    else this.feedback(!this.failedCycle && this.peers.size > 0 ? 'Synced' : '');
  }
  attach(store: DirectPeer) {
    const peer = new SyncPeer(this, store); this.peers.set(store, peer); peer.start();
  }
  detach(store: DirectPeer) { this.peers.get(store)?.dispose(); }
  release(peer: SyncPeer) {
    this.peers.delete(peer.store);
    for (const [id, owner] of this.reservations) if (owner === peer) this.reservations.delete(id);
    for (const other of this.peers.values()) void other.reconsider().catch(error => this.error(error instanceof Error ? error.message : 'History sync failed.'));
    this.status();
  }
  dispose() { this.disposed = true; this.off(); for (const peer of [...this.peers.values()]) peer.dispose(); this.peers.clear(); this.reservations.clear(); }
}
class SyncPeer {
  private stopped = false;
  private missing: string[] = [];
  private remoteIds = new Set<string>();
  private requested?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private outgoing: string[] = [];
  private processing = false;
  private inventoryPending = false;
  private advertising = false;
  private off?: () => void;
  private incomingChain = Promise.resolve();
  get busy() { return this.inventoryPending || this.advertising || !!this.requested || this.processing || this.missing.length > 0; }
  constructor(private readonly manager: HistorySync, readonly store: DirectPeer) {}
  start() {
    this.store.persistItem = async (item, blob) => {
      await this.manager.history.put(item, blob);
      // A second peer may have committed the same immutable item first.
      if (this.requested === item.id) { this.manager.reservations.delete(item.id); this.received(item.id); }
    };
    this.store.onHistoryMessage = message => {
      this.incomingChain = this.incomingChain.then(() => this.handle(message));
      return this.incomingChain;
    };
    let connected = false;
    const changed = () => {
      const state = this.store.getSnapshot();
      if (this.requested && state.transfers.some(item => item.id === this.requested && ['receiving', 'verifying'].includes(item.phase))) this.armTimeout();
      if (state.status === 'connected' && !connected) {
        connected = true; this.inventoryPending = true; this.manager.status();
        void this.inventory().catch(error => this.report(error));
      } else if (connected && state.status !== 'connected') this.dispose();
    };
    this.off = this.store.subscribe(changed); changed();
  }
  private report(error: unknown) { this.manager.error(error instanceof Error ? error.message : 'History sync failed.'); }
  async inventory() {
    if (this.stopped || this.store.getSnapshot().status !== 'connected') return;
    this.advertising = true; this.manager.status();
    try {
      let after: string | undefined;
      do {
        const page = await this.manager.history.inventoryPage(after);
        if (this.stopped) return;
        this.store.sendHistory({ type: 'inventory', items: page, complete: page.length < 48 });
        if (page.length < 48) break;
        after = page.at(-1)!.id;
      } while (!this.stopped);
    } finally { this.advertising = false; this.manager.status(); }
  }

  announce(item: InventoryItem) {
    if (this.stopped || this.store.getSnapshot().status !== 'connected') return;
    try { this.store.sendHistory({ type: 'inventory', items: [{ id: item.id, createdAt: item.createdAt, type: item.type, ...(item.type === 'file' ? { size: item.size, hash: item.hash } : {}) }] }); }
    catch (error) { this.report(error); }
  }
  private async handle(message: Record<string, unknown>) {
    if (this.stopped) return;
    if (message.type === 'inventory') {
      if (!Array.isArray(message.items) || message.items.length > 48) throw new Error('Invalid history inventory.');
      for (const item of message.items) {
        if (!item || !uuid.test(item.id) || !Number.isSafeInteger(item.createdAt) || !['text', 'file'].includes(item.type)) throw new Error('Invalid history inventory.');
        this.remoteIds.add(item.id);
        if (!(await this.manager.history.get(item.id)) && !this.manager.reservations.has(item.id)) {
          this.manager.reservations.set(item.id, this); this.missing.push(item.id);
        }
      }
      await this.manager.history.refresh();
      if (message.complete !== false) this.inventoryPending = false;
      await this.next();
    } else if (message.type === 'item-request') {
      if (typeof message.id !== 'string' || !uuid.test(message.id)) throw new Error('Invalid history request.');
      if (!this.outgoing.includes(message.id)) this.outgoing.push(message.id);
      void this.sendNext().catch(error => this.report(error));
    } else if (message.type === 'item-unavailable') {
      if (typeof message.id !== 'string' || message.id !== this.requested) throw new Error('Invalid history response.');
      this.manager.error('Requested history item unavailable.');
      this.manager.reservations.delete(message.id); this.received(message.id);
    }
  }
  async reconsider() {
    if (this.stopped) return;
    for (const id of this.remoteIds) {
      if (!(await this.manager.history.get(id)) && !this.manager.reservations.has(id)) {
        this.manager.reservations.set(id, this); this.missing.push(id);
      }
    }
    await this.next();
  }
  private async next() {
    if (this.stopped || this.requested) return;
    while (this.missing.length) {
      const id = this.missing.shift()!;
      const existing = await this.manager.history.get(id);
      if (this.stopped) return;
      if (existing) { this.manager.reservations.delete(id); continue; }
      this.requested = id;
      this.armTimeout();
      this.store.sendHistory({ type: 'item-request', id }); break;
    }
    this.manager.status();
  }
  private armTimeout() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.manager.error('History sync timed out. Reconnecting…'); this.store.disconnect(); }, 45000);
  }
  received(id: string) {
    if (this.requested !== id) return;
    clearTimeout(this.timer); this.requested = undefined;
    void this.next().catch(error => this.report(error));
  }
  private async sendNext() {
    if (this.processing || this.stopped) return;
    this.processing = true; this.manager.status();
    try {
      while (this.outgoing.length && !this.stopped) {
        const id = this.outgoing.shift()!;
        const item: HistoryItem | undefined = await this.manager.history.get(id);
        if (this.stopped) return;
        if (!item) { this.store.sendHistory({ type: 'item-unavailable', id }); continue; }
        if (item.type === 'text') this.store.sendText(item.text, item.id, item);
        else {
          const blob = await this.manager.history.blob(id);
          await this.store.sendFile(new File([blob], item.name, { type: item.mimeType }), id, item);
        }
      }
    } finally { this.processing = false; this.manager.status(); }
  }
  dispose() {
    if (this.stopped) return;
    this.stopped = true; this.inventoryPending = false; this.advertising = false; clearTimeout(this.timer); this.off?.(); this.manager.release(this);
  }
}
