import { useSyncExternalStore } from 'react';
import { DirectPeer } from './peer';

export const peerStore = new DirectPeer();
export const usePeer = () => useSyncExternalStore(peerStore.subscribe, peerStore.getSnapshot);
