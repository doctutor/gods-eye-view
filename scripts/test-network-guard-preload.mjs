// Personal fork: `node --import` entry that keeps a test file offline
// (test-network-guard.mjs). Not part of upstream God's Eye View.
import { installNetworkGuard } from './test-network-guard.mjs';

installNetworkGuard();
