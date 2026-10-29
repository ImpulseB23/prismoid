// Stream manager state for the signed-in broadcaster's own channel: title
// and category, category search, and the latest poll and prediction. An
// initial load reads all three from Helix; after that the poll and
// prediction stay live from the EventSub updates ChatFeed hands over.
// Each area has its own pending flag and error so the panel can show them
// side by side. The commands and the owner id are injected for tests.

import { createSignal } from "solid-js";
import * as api from "../lib/streamManager";
import type {
  Category,
  ChannelInfo,
  ChannelInfoUpdate,
  NewPoll,
  NewPrediction,
  Poll,
  Prediction,
} from "../lib/streamManager";
import { currentUserId } from "./authStore";

export type StreamManagerApi = Pick<
  typeof api,
  | "getChannelInfo"
  | "updateChannelInfo"
  | "searchCategories"
  | "getPoll"
  | "createPoll"
  | "endPoll"
  | "getPrediction"
  | "createPrediction"
  | "lockPrediction"
  | "resolvePrediction"
  | "cancelPrediction"
>;

export interface StreamManagerStore {
  channelInfo: () => ChannelInfo | null;
  /** Latest poll, running or finished; null if there never was one. */
  poll: () => Poll | null;
  /** Latest prediction, running or finished; null if there never was one. */
  prediction: () => Prediction | null;
  /** True while the initial load runs. */
  loading: () => boolean;
  infoPending: () => boolean;
  infoError: () => unknown;
  pollPending: () => boolean;
  pollError: () => unknown;
  predictionPending: () => boolean;
  predictionError: () => unknown;
  categories: () => Category[];
  searching: () => boolean;
  searchError: () => unknown;
  /** Reads title, category, poll and prediction for the signed-in user. */
  load: () => Promise<void>;
  /** The actions resolve true once Twitch accepted the change. */
  updateInfo: (update: ChannelInfoUpdate) => Promise<boolean>;
  /** Latest query wins; a blank one clears the results. */
  searchCategories: (query: string) => Promise<void>;
  createPoll: (poll: NewPoll) => Promise<boolean>;
  endPoll: (pollId: string, archive: boolean) => Promise<boolean>;
  createPrediction: (prediction: NewPrediction) => Promise<boolean>;
  lockPrediction: (predictionId: string) => Promise<boolean>;
  resolvePrediction: (
    predictionId: string,
    winningOutcomeId: string,
  ) => Promise<boolean>;
  cancelPrediction: (predictionId: string) => Promise<boolean>;
  /** Live update from EventSub; ignored unless it is the user's channel. */
  applyPoll: (poll: Poll) => void;
  applyPrediction: (prediction: Prediction) => void;
  clear: () => void;
}

const pollRank = (p: Poll) => (p.status === "active" ? 0 : 1);

const predictionRank = (p: Prediction) =>
  p.status === "active" ? 0 : p.status === "locked" ? 1 : 2;

/**
 * Whether `next` should replace `current`. EventSub does not promise order,
 * and a Helix answer can land after a notification, so an older poll never
 * replaces a newer one and a finished one never goes back to running.
 */
function supersedes<T extends { id: string; started_at: number }>(
  current: T | null,
  next: T,
  rank: (x: T) => number,
): boolean {
  if (!current) return true;
  if (current.id !== next.id) return next.started_at >= current.started_at;
  return rank(next) >= rank(current);
}

export function createStreamManagerStore(
  commands: StreamManagerApi = api,
  ownerId: () => string | null = currentUserId,
): StreamManagerStore {
  const [channelInfo, setChannelInfo] = createSignal<ChannelInfo | null>(null);
  const [poll, setPoll] = createSignal<Poll | null>(null);
  const [prediction, setPrediction] = createSignal<Prediction | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [infoPending, setInfoPending] = createSignal(false);
  const [infoError, setInfoError] = createSignal<unknown>(null);
  const [pollPending, setPollPending] = createSignal(false);
  const [pollError, setPollError] = createSignal<unknown>(null);
  const [predictionPending, setPredictionPending] = createSignal(false);
  const [predictionError, setPredictionError] = createSignal<unknown>(null);
  const [categories, setCategories] = createSignal<Category[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searchError, setSearchError] = createSignal<unknown>(null);
  // Bumped by clear() so nothing in flight writes into a signed-out store.
  let generation = 0;
  let searchGeneration = 0;

  function offerPoll(next: Poll): void {
    if (supersedes(poll(), next, pollRank)) setPoll(next);
  }

  function offerPrediction(next: Prediction): void {
    if (supersedes(prediction(), next, predictionRank)) setPrediction(next);
  }

  async function load(): Promise<void> {
    if (ownerId() === null) return;
    const gen = generation;
    setLoading(true);
    const [info, latestPoll, latestPrediction] = await Promise.allSettled([
      commands.getChannelInfo(),
      commands.getPoll(),
      commands.getPrediction(),
    ]);
    if (gen !== generation) return;
    if (info.status === "fulfilled") {
      setChannelInfo(info.value);
      setInfoError(null);
    } else setInfoError(info.reason);
    if (latestPoll.status === "fulfilled") {
      if (latestPoll.value) offerPoll(latestPoll.value);
      setPollError(null);
    } else setPollError(latestPoll.reason);
    if (latestPrediction.status === "fulfilled") {
      if (latestPrediction.value) offerPrediction(latestPrediction.value);
      setPredictionError(null);
    } else setPredictionError(latestPrediction.reason);
    setLoading(false);
  }

  async function run<T>(
    setPending: (v: boolean) => void,
    setError: (e: unknown) => void,
    call: () => Promise<T>,
    done: (value: T) => void,
  ): Promise<boolean> {
    const gen = generation;
    setPending(true);
    setError(null);
    try {
      const value = await call();
      if (gen === generation) done(value);
      return true;
    } catch (e) {
      if (gen === generation) setError(e);
      return false;
    } finally {
      if (gen === generation) setPending(false);
    }
  }

  const pollAction = (call: () => Promise<Poll>) =>
    run(setPollPending, setPollError, call, offerPoll);

  const predictionAction = (call: () => Promise<Prediction>) =>
    run(setPredictionPending, setPredictionError, call, offerPrediction);

  async function searchCategories(query: string): Promise<void> {
    const gen = ++searchGeneration;
    const q = query.trim();
    if (q === "") {
      setCategories([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const found = await commands.searchCategories(q);
      if (gen !== searchGeneration) return;
      setCategories(found);
      setSearchError(null);
    } catch (e) {
      if (gen === searchGeneration) setSearchError(e);
    } finally {
      if (gen === searchGeneration) setSearching(false);
    }
  }

  return {
    channelInfo,
    poll,
    prediction,
    loading,
    infoPending,
    infoError,
    pollPending,
    pollError,
    predictionPending,
    predictionError,
    categories,
    searching,
    searchError,
    load,
    updateInfo: (update) =>
      run(
        setInfoPending,
        setInfoError,
        () => commands.updateChannelInfo(update),
        setChannelInfo,
      ),
    searchCategories,
    createPoll: (p) => pollAction(() => commands.createPoll(p)),
    endPoll: (id, archive) => pollAction(() => commands.endPoll(id, archive)),
    createPrediction: (p) =>
      predictionAction(() => commands.createPrediction(p)),
    lockPrediction: (id) => predictionAction(() => commands.lockPrediction(id)),
    resolvePrediction: (id, outcome) =>
      predictionAction(() => commands.resolvePrediction(id, outcome)),
    cancelPrediction: (id) =>
      predictionAction(() => commands.cancelPrediction(id)),
    applyPoll: (p) => {
      if (p.channel_id === ownerId()) offerPoll(p);
    },
    applyPrediction: (p) => {
      if (p.channel_id === ownerId()) offerPrediction(p);
    },
    clear: () => {
      generation++;
      searchGeneration++;
      setChannelInfo(null);
      setPoll(null);
      setPrediction(null);
      setLoading(false);
      setInfoPending(false);
      setInfoError(null);
      setPollPending(false);
      setPollError(null);
      setPredictionPending(false);
      setPredictionError(null);
      setCategories([]);
      setSearching(false);
      setSearchError(null);
    },
  };
}

const defaultStore = createStreamManagerStore();
export const streamChannelInfo = defaultStore.channelInfo;
export const currentPoll = defaultStore.poll;
export const currentPrediction = defaultStore.prediction;
export const streamManagerLoading = defaultStore.loading;
export const channelInfoPending = defaultStore.infoPending;
export const channelInfoError = defaultStore.infoError;
export const pollPending = defaultStore.pollPending;
export const pollError = defaultStore.pollError;
export const predictionPending = defaultStore.predictionPending;
export const predictionError = defaultStore.predictionError;
export const categoryResults = defaultStore.categories;
export const categorySearching = defaultStore.searching;
export const categorySearchError = defaultStore.searchError;
export const loadStreamManager = defaultStore.load;
export const updateChannelInfo = defaultStore.updateInfo;
export const searchCategories = defaultStore.searchCategories;
export const createPoll = defaultStore.createPoll;
export const endPoll = defaultStore.endPoll;
export const createPrediction = defaultStore.createPrediction;
export const lockPrediction = defaultStore.lockPrediction;
export const resolvePrediction = defaultStore.resolvePrediction;
export const cancelPrediction = defaultStore.cancelPrediction;
export const applyPollUpdate = defaultStore.applyPoll;
export const applyPredictionUpdate = defaultStore.applyPrediction;
export const clearStreamManager = defaultStore.clear;
